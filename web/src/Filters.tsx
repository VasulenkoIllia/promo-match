import { useId, useState } from "react";
import type { SearchOptions, SharedGroupOption } from "./api";
import { type FactKey, type FilterState, type SharedCategoryEntry, withoutFact } from "./format";
import { withSources } from "./supplier-categories";
import { SupplierCategoryPicker } from "./SupplierCategoryPicker";
import { factText, text } from "./text";

interface CategoryPickerProps {
  groups: SharedGroupOption[];
  chosen: string[];
  categories: Map<string, SharedCategoryEntry>;
  onChange: (chosen: string[]) => void;
}

// A group or a category is picked, then added with the button: a select that added on change would add every option
// the arrow keys pass on Windows
function CategoryPicker({ groups, chosen, categories, onChange }: CategoryPickerProps) {
  const [picked, setPicked] = useState("");
  const selectId = useId();
  const isUnavailable = (code: string, models: number) => !models || chosen.includes(code);

  const add = () => {
    if (picked && !chosen.includes(picked)) onChange([...chosen, picked]);
    setPicked("");
  };

  return (
    <div className="panel-block">
      <label htmlFor={selectId} className="label">{text.filters.categories}</label>
      <div className="pick">
        <select id={selectId} value={picked} onChange={(event) => setPicked(event.target.value)}>
          <option value="">{text.filters.pickCategory}</option>
          {groups.map((group) => (
            <optgroup key={group.code} label={group.name.uk}>
              <option value={group.code} disabled={isUnavailable(group.code, group.models)}>
                {text.filters.wholeGroup(group.models)}
              </option>
              {group.categories.map((category) => (
                <option key={category.code} value={category.code} disabled={isUnavailable(category.code, category.models)}>
                  {text.filters.category(category.name.uk, category.models)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button type="button" disabled={!picked} onClick={add}>{text.filters.addCategory}</button>
      </div>
      {chosen.length > 0 && (
        <ul className="chips">
          {chosen.map((code) => {
            const name = categories.get(code)?.name ?? code;
            return (
              <li key={code} className="chip">
                {name}
                <button
                  type="button"
                  aria-label={text.filters.removeCategory(name)}
                  onClick={() => onChange(chosen.filter((each) => each !== code))}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface AppliedFactsProps {
  value: FilterState;
  onChange: (next: FilterState) => void;
}

// The hard filters added from what a query asked; a model the catalogue says nothing of does not pass them
function AppliedFacts({ value, onChange }: AppliedFactsProps) {
  const keys = Object.keys(value.facts) as FactKey[];
  if (!keys.length) return null;
  return (
    <div className="panel-block">
      <p className="label">{text.filters.facts}</p>
      <ul className="chips">
        {keys.map((key) => {
          const name = factText({ [key]: value.facts[key] });
          return (
            <li key={key} className="chip">
              {name}
              <button
                type="button"
                aria-label={text.filters.removeFact(name)}
                onClick={() => onChange({ ...value, facts: withoutFact(value.facts, key) })}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      <p className="hint">{text.filters.factsHint}</p>
    </div>
  );
}

// Off by default: the suppliers' catalogues state these facts unevenly, so the pass leans to the fuller ones
// (src/search/condition-pass.ts)
function ConditionPassSwitch({ value, onChange }: AppliedFactsProps) {
  const hintId = useId();
  return (
    <div className="panel-block">
      <label className="check">
        <input
          type="checkbox"
          checked={value.isConditionPass}
          aria-describedby={hintId}
          onChange={(event) => onChange({ ...value, isConditionPass: event.target.checked })}
        />
        {text.filters.conditionPass}
      </label>
      <p id={hintId} className="hint">{text.filters.conditionPassHint}</p>
    </div>
  );
}

interface FiltersProps {
  options: SearchOptions;
  value: FilterState;
  onChange: (next: FilterState) => void;
  categories: Map<string, SharedCategoryEntry>;
  isMinStockInvalid: boolean;
}

export function Filters({ options, value, onChange, categories, isMinStockInvalid }: FiltersProps) {
  const ids = { minStock: useId(), minStockHint: useId(), noStockHint: useId(), model: useId() };
  // A server without the field says nothing of stock, rather than that no one has it
  const withoutStock = options.sources.filter((source) => source.hasStock === false).map((source) => source.name);

  const toggleSource = (code: string, isChecked: boolean) => onChange(withSources(value,
    isChecked ? [...value.sources, code] : value.sources.filter((each) => each !== code)));
  // The one supplier chosen, whose own tree is shown
  const onlySource = value.sources.length === 1 ? options.sources.find((source) => source.code === value.sources[0]) : undefined;

  return (
    <>
      <fieldset className="panel-block">
        <legend>{text.filters.sources}</legend>
        {options.sources.map((source) => (
          <label key={source.code} className="check">
            <input
              type="checkbox"
              checked={value.sources.includes(source.code)}
              onChange={(event) => toggleSource(source.code, event.target.checked)}
            />
            {source.name}
          </label>
        ))}
        <p className="hint">{text.filters.sourcesHint}</p>
      </fieldset>

      <CategoryPicker
        groups={options.sharedCategories}
        chosen={value.sharedCategories}
        categories={categories}
        onChange={(sharedCategories) => onChange({ ...value, sharedCategories })}
      />

      {onlySource && (
        <SupplierCategoryPicker
          source={onlySource}
          options={options.categories}
          chosen={value.supplierCategories}
          onChange={(supplierCategories) => onChange({ ...value, supplierCategories })}
        />
      )}

      <AppliedFacts value={value} onChange={onChange} />

      <ConditionPassSwitch value={value} onChange={onChange} />

      <div className="panel-block">
        <label htmlFor={ids.minStock} className="label">{text.filters.minStock}</label>
        {/* Text, not number: a number field reports "" for "-" or "1e", and the filter would drop silently */}
        <input
          id={ids.minStock}
          type="text"
          inputMode="numeric"
          value={value.minStock}
          aria-invalid={isMinStockInvalid}
          aria-describedby={withoutStock.length ? `${ids.minStockHint} ${ids.noStockHint}` : ids.minStockHint}
          onChange={(event) => onChange({ ...value, minStock: event.target.value })}
        />
        <p id={ids.minStockHint} className={isMinStockInvalid ? "error-text" : "hint"}>
          {isMinStockInvalid ? text.filters.minStockInvalid : text.filters.minStockHint}
        </p>
        {withoutStock.length > 0 && <p id={ids.noStockHint} className="hint">{text.filters.minStockNoData(withoutStock)}</p>}
      </div>

      <div className="panel-block">
        <label htmlFor={ids.model} className="label">{text.filters.model}</label>
        <select id={ids.model} value={value.model} onChange={(event) => onChange({ ...value, model: event.target.value })}>
          {options.models.map((model) => (
            <option key={model.name} value={model.name} disabled={!model.isConfigured}>
              {[model.name, model.isDefault && text.filters.modelDefault, !model.isConfigured && text.filters.modelNoKey]
                .filter(Boolean).join(", ")}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
