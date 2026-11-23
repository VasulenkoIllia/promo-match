// The admin's search settings in the database (src/search/settings.ts): one row, id 1, its settings as JSON, who saved
// them and when. Without the row the code's defaults hold. Read on every search: one row by its key.
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { CODE_DEFAULT_SETTINGS, mergeSettings, type SearchSettings, storedSettings } from "./settings.js";

const ROW_ID = 1;

export interface SearchDefaults {
  // The defaults of every search: the code's, under what the admin saved
  defaults: SearchSettings;
  // null: the admin has not saved any
  updatedAt: Date | null;
  // Saved keys or values this release does not know (src/search/settings.ts, storedSettings), for the log
  dropped: string[];
}

export interface SearchSettingsService {
  read(): Promise<SearchDefaults>;
  save(settings: SearchSettings, userId: number): Promise<SearchDefaults>;
}

function defaultsOf(row: { settings: unknown; updatedAt: Date } | null): SearchDefaults {
  const { settings, dropped } = storedSettings(row?.settings ?? {});
  return { defaults: mergeSettings(CODE_DEFAULT_SETTINGS, settings), updatedAt: row?.updatedAt ?? null, dropped };
}

export function createSearchSettingsService(db: PrismaClient): SearchSettingsService {
  const select = { settings: true, updatedAt: true } as const;
  return {
    async read() {
      return defaultsOf(await db.searchSetting.findUnique({ where: { id: ROW_ID }, select }));
    },

    // Every setting is saved, so the row says what the admin chose even where it is the code's default
    async save(settings, userId) {
      const json = settings as unknown as Prisma.InputJsonObject;
      const row = await db.searchSetting.upsert({
        where: { id: ROW_ID },
        create: { id: ROW_ID, settings: json, updatedById: userId },
        update: { settings: json, updatedById: userId, updatedAt: new Date() },
        select,
      });
      return defaultsOf(row);
    },
  };
}
