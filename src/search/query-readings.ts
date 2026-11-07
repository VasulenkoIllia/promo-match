// What Claude answered to a search's text, so that the same text reads the same: two calls read a text differently, and
// the results move with the reading (docs/integrations.md, «Claude API»). A reading goes by the parse model, the prompt
// and the text; the text itself is kept only as its hash (prisma/schema.prisma, QueryReading). What is kept is the
// model's JSON, not what was read from it: the reader goes through the contract's check every time.
import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";

// A process's own readings, the latest kept
const MAX_REMEMBERED = 200;

export interface ReadingKey {
  parseModel: string;
  promptSha256: string;
  textSha256: string;
}

export interface QueryReadings {
  find(key: ReadingKey): Promise<string | undefined>;
  // The answer that stays for the key: this one, or the one of a search that read the same text first, so two searches
  // at once show the same reading
  keep(key: ReadingKey, answer: string): Promise<string>;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// The text as it came: a text told apart by a letter's case or a space is another text
export function readingKey(parseModel: string, promptSha256: string, text: string): ReadingKey {
  return { parseModel, promptSha256, textSha256: sha256(text) };
}

// For the scripts that measure the readings themselves: QUERY_PARSE_DRAW needs a text read again, not the reading a
// search kept, and a prompt under test should leave nothing behind
export function memoryReadings(): QueryReadings {
  const answers = new Map<string, string>();
  const id = (key: ReadingKey) => JSON.stringify([key.parseModel, key.promptSha256, key.textSha256]);
  return {
    find: (key) => Promise.resolve(answers.get(id(key))),
    keep: (key, answer) => {
      const known = answers.get(id(key));
      if (known !== undefined) return Promise.resolve(known);
      if (answers.size >= MAX_REMEMBERED) {
        const [oldest] = answers.keys();
        if (oldest !== undefined) answers.delete(oldest);
      }
      answers.set(id(key), answer);
      return Promise.resolve(answer);
    },
  };
}

export function postgresReadings(db: PrismaClient): QueryReadings {
  return {
    find: async (key) => {
      const row = await db.queryReading.findUnique({
        where: { parseModel_promptSha256_textSha256: key }, select: { answer: true },
      });
      return row?.answer;
    },
    // DO UPDATE to its own value rather than DO NOTHING, which returns no row when another search got there first
    keep: async ({ parseModel, promptSha256, textSha256 }, answer) => {
      const [row] = await db.$queryRaw<{ answer: string }[]>`
        INSERT INTO query_reading (parse_model, prompt_sha256, text_sha256, answer)
        VALUES (${parseModel}, ${promptSha256}, ${textSha256}, ${answer})
        ON CONFLICT (parse_model, prompt_sha256, text_sha256) DO UPDATE SET answer = query_reading.answer
        RETURNING answer`;
      if (!row) throw new Error("the reading was not kept");
      return row.answer;
    },
  };
}
