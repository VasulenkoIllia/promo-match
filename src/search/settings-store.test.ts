import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";
import { CODE_DEFAULT_SETTINGS } from "./settings.js";
import { createSearchSettingsService } from "./settings-store.js";

const SAVED_AT = new Date("2026-11-23T18:00:00Z");

// A table of one row or none, which records the upserts
function fakeDb(row: { settings: unknown; updatedAt: Date } | null) {
  const upserts: unknown[] = [];
  const db = {
    searchSetting: {
      findUnique: () => Promise.resolve(row),
      upsert: (call: { create: { settings: unknown } }) => {
        upserts.push(call);
        return Promise.resolve({ settings: call.create.settings, updatedAt: SAVED_AT });
      },
    },
  } as unknown as PrismaClient;
  return { db, upserts };
}

describe("createSearchSettingsService", () => {
  it("holds the code's defaults until the admin saves any", async () => {
    expect(await createSearchSettingsService(fakeDb(null).db).read()).toEqual({ defaults: CODE_DEFAULT_SETTINGS, updatedAt: null, dropped: [] });
  });

  it("lays what was saved over the code's defaults, naming the keys it does not know", async () => {
    const { db } = fakeDb({ settings: { colorLift: "strong", removedSwitch: true }, updatedAt: SAVED_AT });
    expect(await createSearchSettingsService(db).read()).toEqual({
      defaults: { ...CODE_DEFAULT_SETTINGS, colorLift: "strong" }, updatedAt: SAVED_AT, dropped: ["removedSwitch"],
    });
  });

  it("saves every setting in the one row, with who saved them", async () => {
    const { db, upserts } = fakeDb(null);
    const settings = { ...CODE_DEFAULT_SETTINGS, isExclusionSink: false };
    expect(await createSearchSettingsService(db).save(settings, 1)).toEqual({ defaults: settings, updatedAt: SAVED_AT, dropped: [] });
    expect(upserts).toEqual([{
      where: { id: 1 }, create: { id: 1, settings, updatedById: 1 },
      update: { settings, updatedById: 1, updatedAt: expect.any(Date) as Date }, select: { settings: true, updatedAt: true },
    }]);
  });
});
