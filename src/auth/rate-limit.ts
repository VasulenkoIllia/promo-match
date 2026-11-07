// A fixed window per key, in the memory of the process: the app runs as one replica (docs/deployment.md), and a restart
// starts the counts over, as it does the daily budgets
const MS_IN_SECOND = 1000;
// Keys may come from anyone (a login, an address): past this the oldest window goes, so the memory stays bounded
const MAX_KEYS = 10_000;

interface Window {
  count: number;
  endsAtMs: number;
}

// Of several limiters' answers to one attempt: 0 lets it go on, otherwise the seconds of the longest wait
export function longestWait(waits: (number | null)[]): number {
  return Math.max(0, ...waits.map((wait) => wait ?? 0));
}

export class RateLimiter {
  // In the order they began: windows are of one length, so the first ones are the first to end
  #windows = new Map<string, Window>();

  constructor(readonly limit: number, readonly windowMs: number, readonly now: () => number = Date.now) {}

  // Counts an attempt before it is made, so parallel ones cannot slip past. Null: go on; a number: refused, the seconds
  // until the window ends.
  take(key: string): number | null {
    const now = this.now();
    const window = this.#windows.get(key);
    if (window && window.endsAtMs > now) {
      if (window.count >= this.limit) return Math.ceil((window.endsAtMs - now) / MS_IN_SECOND);
      window.count += 1;
      return null;
    }
    this.#windows.delete(key);
    this.#makeRoom(now);
    this.#windows.set(key, { count: 1, endsAtMs: now + this.windowMs });
    return null;
  }

  reset(key: string): void {
    this.#windows.delete(key);
  }

  #makeRoom(now: number): void {
    for (const [key, window] of this.#windows) {
      if (window.endsAtMs > now && this.#windows.size < MAX_KEYS) return;
      this.#windows.delete(key);
    }
  }
}
