import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { AuthOptions } from "../auth/routes.js";
import type { SessionUser } from "../auth/store.js";
import { createSearchJournal, type JournalEntry } from "./journal.js";
import type { SearchInput } from "./request.js";
import type { SearchResponse, SearchService } from "./search.js";
import { CODE_DEFAULT_SETTINGS, PHOTO_DECIDES_WEIGHT, type SearchSettings } from "./settings.js";
import type { SearchDefaults, SearchSettingsService } from "./settings-store.js";

const SESSIONS = new Map<string, SessionUser>([
  ["admin", { id: 1, login: "boss", role: "admin" }],
  ["manager", { id: 2, login: "worker", role: "manager" }],
]);
const auth: AuthOptions = {
  isCookieSecure: false,
  service: {
    signIn: () => Promise.resolve(null),
    userOfSession: (token) => Promise.resolve(SESSIONS.get(token) ?? null),
    signOut: () => Promise.resolve(),
  },
};
const UPDATED_AT = new Date("2026-11-23T18:00:00Z");
// What the admin saved: not the code's defaults
const ADMIN_DEFAULTS: SearchSettings = { ...CODE_DEFAULT_SETTINGS, photoOrder: "photo-heavier", colorLift: "off" };

// Keeps what it is given, starting from ADMIN_DEFAULTS
function fakeSettings() {
  const saved: { settings: SearchSettings; userId: number }[] = [];
  let current: SearchDefaults = { defaults: ADMIN_DEFAULTS, updatedAt: UPDATED_AT, dropped: [] };
  const service: SearchSettingsService = {
    read: () => Promise.resolve(current),
    save: (settings, userId) => {
      saved.push({ settings, userId });
      current = { defaults: settings, updatedAt: UPDATED_AT, dropped: [] };
      return Promise.resolve(current);
    },
  };
  return { service, saved };
}

const empty: SearchResponse = {
  model: "gemini-embedding-2/1536", lists: ["text-photo", "text-text"], isComplete: true, hasCloseMatch: null, queryParse: null, tookMs: 5,
  costUsd: 0, results: [],
};

function fakeSearch(): SearchService & { inputs: SearchInput[] } {
  const inputs: SearchInput[] = [];
  return {
    inputs,
    search: (input) => {
      inputs.push(input);
      return Promise.resolve(empty);
    },
    options: () => Promise.reject(new Error("not asked")),
  };
}

let app: ReturnType<typeof buildApp> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const as = (token: string) => ({ cookie: `session=${token}` });

describe("GET /api/search/settings", () => {
  it("gives every signed-in role the defaults, the code's own beside them and when they were saved", async () => {
    app = buildApp({ auth, searchSettings: fakeSettings().service });
    for (const token of ["admin", "manager"]) {
      const response = await app.inject({ method: "GET", url: "/api/search/settings", headers: as(token) });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ defaults: ADMIN_DEFAULTS, codeDefaults: CODE_DEFAULT_SETTINGS, updatedAt: UPDATED_AT.toISOString() });
    }
    const anonymous = await app.inject({ method: "GET", url: "/api/search/settings" });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe("PUT /api/admin/search-settings", () => {
  const every: SearchSettings = { ...CODE_DEFAULT_SETTINGS, photoOrder: "photo-decides", isConditionPass: true };
  const put = (token: string, payload: unknown) =>
    app?.inject({ method: "PUT", url: "/api/admin/search-settings", headers: as(token), payload: payload as Record<string, unknown> });

  it("saves every setting for the admin, under the admin's id", async () => {
    const { service, saved } = fakeSettings();
    app = buildApp({ auth, searchSettings: service });
    const response = await put("admin", { settings: every });
    expect(response?.statusCode).toBe(200);
    expect(response?.json()).toEqual({ defaults: every, codeDefaults: CODE_DEFAULT_SETTINGS, updatedAt: UPDATED_AT.toISOString() });
    expect(saved).toEqual([{ settings: every, userId: 1 }]);
  });

  it("refuses a manager with 403 and saves nothing", async () => {
    const { service, saved } = fakeSettings();
    app = buildApp({ auth, searchSettings: service });
    expect((await put("manager", { settings: every }))?.statusCode).toBe(403);
    expect((await put("stolen", { settings: every }))?.statusCode).toBe(401);
    expect(saved).toEqual([]);
  });

  it.each([
    ["an unknown key", { settings: { ...every, isMagic: true } }],
    ["an unknown level", { settings: { ...every, colorLift: "huge" } }],
    ["an unknown order", { settings: { ...every, photoOrder: "photo-only" } }],
    ["a boolean as a string", { settings: { ...every, isParseQuery: "false" } }],
    ["a setting left out", { settings: { ...every, isExclusionSink: undefined } }],
    ["the settings without their key", every],
  ])("answers 400 to %s and saves nothing", async (_title, payload) => {
    const { service, saved } = fakeSettings();
    app = buildApp({ auth, searchSettings: service });
    expect((await put("admin", JSON.parse(JSON.stringify(payload))))?.statusCode).toBe(400);
    expect(saved).toEqual([]);
  });
});

describe("POST /api/search with settings", () => {
  const post = (search: SearchService, payload: Record<string, unknown>, settings = fakeSettings().service) => {
    const journal = createSearchJournal((entry) => {
      written.push(entry);
      return Promise.resolve();
    });
    const written: JournalEntry[] = [];
    app = buildApp({ auth, search, searchSettings: settings, searchJournal: journal });
    return { written, journal, response: app.inject({ method: "POST", url: "/api/search", headers: as("manager"), payload }) };
  };

  it("searches with the admin's defaults under the user's own, answers and keeps every setting, and names the changed", async () => {
    const search = fakeSearch();
    const { written, journal, response } = post(search, { text: "mug", settings: { photoOrder: "photo-decides", isConditionPass: false } });
    const answer = await response;
    await journal.settle();
    const used = { ...ADMIN_DEFAULTS, photoOrder: "photo-decides" };
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ settings: used, changedSettings: ["photoOrder"] });
    expect(search.inputs[0]).toMatchObject({ listWeights: { "image-photo": PHOTO_DECIDES_WEIGHT }, tuning: { colorLift: null }, conditionPass: null });
    expect(written[0]?.settings).toEqual(used);
  });

  it("searches with the code's defaults when no settings are kept", async () => {
    const search = fakeSearch();
    app = buildApp({ auth, search });
    const answer = await app.inject({ method: "POST", url: "/api/search", headers: as("manager"), payload: { text: "mug" } });
    expect(answer.json()).toMatchObject({ settings: CODE_DEFAULT_SETTINGS, changedSettings: [] });
    expect(search.inputs[0]).toMatchObject({ parseQuery: true, conditionPass: null });
    expect(search.inputs[0]?.tuning).toBeUndefined();
  });

  it("takes the flags of before the settings as the settings of them", async () => {
    const search = fakeSearch();
    const answer = await post(search, { text: "mug", parseQuery: false, conditionPass: true }).response;
    expect(answer.json()).toMatchObject({ changedSettings: ["isParseQuery", "isConditionPass"] });
    expect(search.inputs[0]).toMatchObject({ parseQuery: false, conditionPass: { weight: 0.5 } });
  });

  it.each([
    ["an unknown setting", { text: "mug", settings: { photoWeight: 5 } }],
    ["an unknown level", { text: "mug", settings: { categoryLift: "max" } }],
    ["settings that are not an object", { text: "mug", settings: "photo-decides" }],
    ["a flag and its setting that disagree", { text: "mug", conditionPass: true, settings: { isConditionPass: false } }],
  ])("answers 400 to %s, before any search", async (_title, payload) => {
    const search = fakeSearch();
    expect((await post(search, payload).response).statusCode).toBe(400);
    expect(search.inputs).toEqual([]);
  });
});
