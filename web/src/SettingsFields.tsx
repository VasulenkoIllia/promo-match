import { useId } from "react";
import { SETTING_CHOICES, SETTING_KEYS, type SearchSettings, type SettingKey } from "./search-settings";
import { settingHint, settingName, valueName } from "./settings-text";
import "./settings.css";

interface SettingsFieldsProps {
  value: SearchSettings;
  onChange: <Key extends SettingKey>(key: Key, next: SearchSettings[Key]) => void;
  // A word beside a setting, or none: what differs from the defaults on the search screen, from before the switches on
  // the admin's
  markOf: (key: SettingKey) => string | null;
  isDisabled?: boolean;
}

interface FieldProps extends Omit<SettingsFieldsProps, "value"> {
  settingKey: SettingKey;
  value: SearchSettings;
  idPrefix: string;
}

function Mark({ text }: { text: string | null }) {
  return text ? <span className="setting-mark">{text}</span> : null;
}

function SwitchField({ settingKey, value, onChange, markOf, isDisabled, idPrefix }: FieldProps) {
  const hintId = `${idPrefix}-${settingKey}-hint`;
  return (
    <div className="setting">
      <label className="check">
        <input
          type="checkbox"
          checked={value[settingKey] === true}
          disabled={isDisabled}
          aria-describedby={hintId}
          onChange={(event) => onChange(settingKey, event.target.checked)}
        />
        {settingName(settingKey)}
        <Mark text={markOf(settingKey)} />
      </label>
      <p id={hintId} className="hint">{settingHint(settingKey)}</p>
    </div>
  );
}

function ChoiceField({ settingKey, value, onChange, markOf, isDisabled, idPrefix }: FieldProps) {
  const hintId = `${idPrefix}-${settingKey}-hint`;
  const choices = SETTING_CHOICES[settingKey] ?? [];
  return (
    <fieldset className="setting" aria-describedby={hintId}>
      <legend>
        {settingName(settingKey)}
        <Mark text={markOf(settingKey)} />
      </legend>
      <div className="setting-choices">
        {choices.map((choice) => (
          <label key={choice} className="check">
            <input
              type="radio"
              name={`${idPrefix}-${settingKey}`}
              value={choice}
              checked={value[settingKey] === choice}
              disabled={isDisabled}
              onChange={() => onChange(settingKey, choice)}
            />
            {valueName(choice)}
          </label>
        ))}
      </div>
      <p id={hintId} className="hint">{settingHint(settingKey)}</p>
    </fieldset>
  );
}

// Every search setting, the same on the admin's screen and in the search screen's block
export function SettingsFields(props: SettingsFieldsProps) {
  const idPrefix = useId();
  return (
    <div className="settings-fields">
      {SETTING_KEYS.map((key) => (SETTING_CHOICES[key]
        ? <ChoiceField key={key} settingKey={key} idPrefix={idPrefix} {...props} />
        : <SwitchField key={key} settingKey={key} idPrefix={idPrefix} {...props} />))}
    </div>
  );
}
