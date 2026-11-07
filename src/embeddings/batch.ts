// Pure helpers of the embeddings worker: the spending limit, batches by count and bytes, a few calls at a time, and
// the split of a refused batch down to the item the provider refuses
import { ImportStopped } from "../import/errors.js";
import { InputRejected, ProviderError } from "./api.js";

// The limit of one run is reached: what is left stays pending, the run ends failed so its exit code says so
export class BudgetReached extends ImportStopped {
  override name = "BudgetReached";
}

// Every call is counted at its list price before it is made, and not made when it would pass the limit. A call that
// fails afterwards stays counted: the provider may have billed it. A timeout the HTTP client retries is counted once,
// though the provider may bill each attempt.
export class Budget {
  #spentUsd = 0;

  // limitName: the setting the message names (the search keeps a budget of its own, SEARCH_BUDGET_USD)
  constructor(readonly limitUsd: number, readonly limitName = "EMBED_BUDGET_USD") {}

  get spentUsd(): number {
    return this.#spentUsd;
  }

  reserve(usd: number): void {
    // A broken price would switch the limit off (NaN compares false)
    if (!Number.isFinite(usd) || usd < 0) throw new Error(`a call priced at ${usd} USD`);
    if (this.#spentUsd + usd > this.limitUsd) {
      throw new BudgetReached(`budget reached: spent $${this.#spentUsd.toFixed(4)} of $${this.limitUsd}, the next call `
        + `costs $${usd.toFixed(4)} (${this.limitName})`);
    }
    this.#spentUsd += usd;
  }
}

// Examples of failures for the report, a few per run
const MAX_EXAMPLES = 5;

export function addExample(examples: string[], example: string): void {
  if (examples.length < MAX_EXAMPLES) examples.push(example);
}

// Consecutive items, each batch at most maxItems long and maxBytes in size (an item over maxBytes goes alone)
export function batchesOf<T>(items: T[], maxItems: number, maxBytes: number, bytesOf: (item: T) => number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const itemBytes = bytesOf(item);
    if (current.length && (current.length >= maxItems || size + itemBytes > maxBytes)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemBytes;
  }
  if (current.length) batches.push(current);
  return batches;
}

// At most limit calls at a time, results in the order of the items. After the first failure no new call starts (its
// items get undefined), the ones under way finish, so the vectors already paid for are still written.
export async function mapSettled<T, R>(items: T[], limit: number, call: (item: T) => Promise<R>):
  Promise<(PromiseSettledResult<R> | undefined)[]> {
  const results = new Array<PromiseSettledResult<R> | undefined>(items.length).fill(undefined);
  let next = 0;
  let hasFailed = false;
  const worker = async () => {
    for (let index = next; !hasFailed && index < items.length; index = next) {
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await call(items[index] as T) };
      } catch (error) {
        hasFailed = true;
        results[index] = { status: "rejected", reason: error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export interface SplitResult<T> {
  vectors: Map<T, number[]>;
  // Items the provider refused one by one, with its message
  rejected: Map<T, string>;
  // What stopped the batch (a provider error, the budget, a stop); the vectors got before it are kept above
  failure?: Error;
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// A batch the provider refuses as input (HTTP 400) is sent again item by item, so one broken photo does not hold back
// the others. When every item of a batch of two or more is refused alone, the request is at fault (a key Google
// answers with 400, a changed schema), not the input: that is a provider failure and nothing is marked refused.
export async function embedSplitting<T>(items: T[], embed: (batch: T[]) => Promise<number[][]>): Promise<SplitResult<T>> {
  const result: SplitResult<T> = { vectors: new Map(), rejected: new Map() };
  try {
    const vectors = await embed(items);
    if (vectors.length !== items.length) throw new ProviderError(`${vectors.length} vectors for ${items.length} inputs`);
    items.forEach((item, index) => result.vectors.set(item, vectors[index] as number[]));
    return result;
  } catch (error) {
    if (!(error instanceof InputRejected)) return { ...result, failure: toError(error) };
    const [single] = items;
    if (items.length === 1 && single !== undefined) {
      result.rejected.set(single, error.message);
      return result;
    }
  }
  for (const item of items) {
    const part = await embedSplitting([item], embed);
    for (const [key, vector] of part.vectors) result.vectors.set(key, vector);
    for (const [key, message] of part.rejected) result.rejected.set(key, message);
    if (part.failure !== undefined) return { ...result, failure: part.failure };
  }
  const [first] = result.rejected.values();
  if (result.rejected.size === items.length && first !== undefined) {
    return { vectors: result.vectors, rejected: new Map(), failure: new ProviderError(
      `every one of ${items.length} inputs was refused alone, so the request is at fault, not the input: ${first}`) };
  }
  return result;
}

// Adds the provider's usage numbers of one call to the run's
export function addUsage(total: Record<string, number>, usage: Record<string, number>): void {
  for (const [name, value] of Object.entries(usage)) total[name] = (total[name] ?? 0) + value;
}
