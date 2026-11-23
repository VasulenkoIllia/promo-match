import { useState } from "react";
import { changedKeys, overridesOf, type SearchSettings, type SettingKey } from "./search-settings";
import type { AnswerState, SettingsSource } from "./useSettingsAnswer";

export interface SearchSettingsChoice {
  state: AnswerState;
  // The settings on screen: the defaults with this page's changes over them; null until the defaults come
  value: SearchSettings | null;
  change: <Key extends SettingKey>(key: Key, next: SearchSettings[Key]) => void;
  reset: () => void;
  retry: () => void;
  changed: SettingKey[];
  // What a search sends: only the settings changed here, so the server's defaults hold for the rest, and none while the
  // defaults could not be read
  overrides: Partial<SearchSettings>;
}

// The search screen's own settings: only the changes are kept, so new defaults read later show at once under them
export function useSearchSettings(source: SettingsSource): SearchSettingsChoice {
  const [edits, setEdits] = useState<Partial<SearchSettings>>({});
  const defaults = source.state.kind === "ok" ? source.state.answer.defaults : null;
  const value = defaults ? { ...defaults, ...edits } : null;
  return {
    state: source.state,
    value,
    // A setting set back to its default is no change: new defaults must not keep the old one on this page
    change: (key, next) => setEdits((current) => (defaults ? overridesOf({ ...defaults, ...current, [key]: next }, defaults) : current)),
    reset: () => setEdits({}),
    retry: source.retry,
    changed: defaults && value ? changedKeys(value, defaults) : [],
    overrides: defaults && value ? overridesOf(value, defaults) : {},
  };
}
