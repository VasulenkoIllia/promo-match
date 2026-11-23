import { type SubmitEvent, useState } from "react";
import { hasNoListFor, type SearchSettings, type SettingKey, type SettingsAnswer } from "./search-settings";
import { saveSearchSettings } from "./search-settings-api";
import { ErrorNote } from "./SearchView";
import { settingsErrorText, settingsText } from "./settings-text";
import { SettingsFields } from "./SettingsFields";
import { type ErrorText, errorTextFor } from "./text";
import { useSettingsAnswer } from "./useSettingsAnswer";

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; error: ErrorText };

interface SettingsFormProps {
  answer: SettingsAnswer;
  onSaved: (answer: SettingsAnswer) => void;
}

// The admin's defaults for every search; a mark says where a setting differs from the search of before the switches
function SettingsForm({ answer, onSaved }: SettingsFormProps) {
  const [draft, setDraft] = useState<SearchSettings>(answer.defaults);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const isSaving = save.kind === "saving";

  const change = <Key extends SettingKey>(key: Key, next: SearchSettings[Key]) => {
    setDraft((current) => ({ ...current, [key]: next }));
    if (!isSaving) setSave({ kind: "idle" });
  };

  // A save of what is already saved is allowed: it also drops from the row what this version no longer knows
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSaving) return;
    setSave({ kind: "saving" });
    try {
      const saved = await saveSearchSettings(draft);
      setDraft(saved.defaults);
      setSave({ kind: "saved" });
      onSaved(saved);
    } catch (error) {
      setSave({ kind: "error", error: errorTextFor(error, settingsErrorText) });
    }
  };

  const markOf = (key: keyof SearchSettings) =>
    (draft[key] === answer.codeDefaults[key] ? null : settingsText.beforeSwitches(answer.codeDefaults[key]));
  return (
    <form onSubmit={(event) => void submit(event)}>
      <SettingsFields value={draft} onChange={change} markOf={markOf} isDisabled={isSaving} />
      {hasNoListFor(draft, false) && <p className="note warn">{settingsText.noTextList}</p>}
      {/* aria-disabled rather than disabled while saving: the focus stays on the button */}
      <div className="settings-actions">
        <button type="submit" className="primary" aria-disabled={isSaving}>
          {isSaving ? settingsText.saving : settingsText.save}
        </button>
        <button
          type="button"
          aria-disabled={isSaving}
          onClick={() => {
            if (isSaving) return;
            setDraft(answer.codeDefaults);
            setSave({ kind: "idle" });
          }}
        >
          {settingsText.codeDefaults}
        </button>
        <span className="hint" role="status">{save.kind === "saved" ? settingsText.saved : ""}</span>
      </div>
      <p className="hint">{settingsText.codeDefaultsHint}</p>
      {save.kind === "error" && <ErrorNote error={save.error} />}
    </form>
  );
}

// The «Налаштування пошуку» tab, the admin's alone: the server refuses a manager's save anyway (403). It reads the
// defaults again on each opening, so a save starts from what another admin may have saved meanwhile.
export function SearchSettingsView({ onSaved }: { onSaved: (answer: SettingsAnswer) => void }) {
  const { state, retry, replace } = useSettingsAnswer();

  const saved = (answer: SettingsAnswer) => {
    replace(answer);
    onSaved(answer);
  };

  return (
    <main className="settings-page">
      <h1>{settingsText.heading}</h1>
      <p className="hint">{settingsText.intro}</p>
      {state.kind === "loading" && <p className="hint">{settingsText.loading}</p>}
      {state.kind === "error" && (
        <ErrorNote error={{ ...state.error, message: `${settingsText.loadFailed} ${state.error.message}` }}>
          <button type="button" onClick={retry}>{settingsText.retry}</button>
        </ErrorNote>
      )}
      {state.kind === "ok" && (
        <>
          <p className="hint">{settingsText.updatedAt(state.answer.updatedAt)}</p>
          <SettingsForm answer={state.answer} onSaved={saved} />
        </>
      )}
    </main>
  );
}
