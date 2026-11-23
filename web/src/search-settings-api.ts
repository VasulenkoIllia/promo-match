// The search settings API of the server (src/search/settings-routes.ts, docs/integrations.md, «Налаштування пошуку»)
import { ApiError, call, JSON_HEADERS } from "./api";
import { type SearchSettings, SETTING_KEYS, type SettingsAnswer } from "./search-settings";

const SETTINGS_TIMEOUT_MS = 15_000;

// Every setting the screens show is there: a server of another version would otherwise leave a switch without a value
function checked(answer: SettingsAnswer): SettingsAnswer {
  const isFull = (settings: unknown) => typeof settings === "object" && settings !== null
    && SETTING_KEYS.every((key) => key in settings);
  if (!isFull(answer.defaults) || !isFull(answer.codeDefaults)) throw new ApiError({ kind: "bad-answer" });
  return answer;
}

export async function fetchSearchSettings(signal: AbortSignal): Promise<SettingsAnswer> {
  return checked(await call<SettingsAnswer>("/api/search/settings", {}, SETTINGS_TIMEOUT_MS, [], signal));
}

// The admin's alone: a manager gets 403
export async function saveSearchSettings(settings: SearchSettings): Promise<SettingsAnswer> {
  return checked(await call<SettingsAnswer>("/api/admin/search-settings", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ settings }),
  }, SETTINGS_TIMEOUT_MS, []));
}
