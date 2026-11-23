import { ErrorNote } from "./SearchView";
import { settingsText } from "./settings-text";
import { SettingsFields } from "./SettingsFields";
import type { SearchSettingsChoice } from "./useSearchSettings";

// The search screen's settings, folded: whoever searches may change them for their own searches on this page
export function SearchSettingsBlock({ choice }: { choice: SearchSettingsChoice }) {
  const { state, value, changed } = choice;
  // aria-disabled rather than disabled: a reset keeps the focus on its button
  const isResetOff = !changed.length;
  return (
    <details className="panel-block settings-block">
      <summary>{state.kind === "error" ? settingsText.summaryFailed : settingsText.summary(changed.length)}</summary>
      {state.kind === "loading" && <p className="hint">{settingsText.loading}</p>}
      {state.kind === "error" && (
        <ErrorNote error={{ ...state.error, message: `${settingsText.searchLoadFailed} ${state.error.message}` }}>
          <button type="button" onClick={choice.retry}>{settingsText.retry}</button>
        </ErrorNote>
      )}
      {state.kind === "ok" && value && (
        <>
          <p className="hint">{settingsText.blockHint}</p>
          <SettingsFields
            value={value}
            onChange={choice.change}
            markOf={(key) => (changed.includes(key) ? settingsText.changed : null)}
          />
          <div className="settings-actions">
            <button
              type="button"
              aria-disabled={isResetOff}
              onClick={() => {
                if (!isResetOff) choice.reset();
              }}
            >
              {settingsText.reset}
            </button>
          </div>
        </>
      )}
    </details>
  );
}
