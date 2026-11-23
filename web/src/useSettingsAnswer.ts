import { useCallback, useEffect, useState } from "react";
import type { SettingsAnswer } from "./search-settings";
import { fetchSearchSettings } from "./search-settings-api";
import { settingsErrorText } from "./settings-text";
import { type ErrorText, errorTextFor } from "./text";

export type AnswerState = { kind: "loading" } | { kind: "ok"; answer: SettingsAnswer } | { kind: "error"; error: ErrorText };

export interface SettingsSource {
  state: AnswerState;
  // After a failed read: shows the loading again
  retry: () => void;
  // Reads again and keeps what it has meanwhile: the defaults may have changed on the server
  refresh: () => void;
  // The answer of a save, and a read after it, so a read begun before the save does not bring back the old defaults
  replace: (answer: SettingsAnswer) => void;
}

// The search settings of GET /api/search/settings, read again whenever the page comes back into view
export function useSettingsAnswer(): SettingsSource {
  const [state, setState] = useState<AnswerState>({ kind: "loading" });
  const [load, setLoad] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchSearchSettings(controller.signal)
      .then((answer) => setState({ kind: "ok", answer }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const failed = errorTextFor(error, settingsErrorText);
        // A refresh that fails keeps the defaults it read before: the server applies its own either way
        setState((current) => (current.kind === "ok" ? current : { kind: "error", error: failed }));
      });
    return () => controller.abort();
  }, [load]);

  const refresh = useCallback(() => setLoad((count) => count + 1), []);

  useEffect(() => {
    const onShown = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onShown);
    return () => document.removeEventListener("visibilitychange", onShown);
  }, [refresh]);

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    refresh();
  }, [refresh]);

  const replace = useCallback((answer: SettingsAnswer) => {
    setState({ kind: "ok", answer });
    refresh();
  }, [refresh]);

  return { state, retry, refresh, replace };
}
