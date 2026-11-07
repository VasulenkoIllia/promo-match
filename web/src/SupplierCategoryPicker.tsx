import { useId, useMemo, useState } from "react";
import type { CategoryFilter, CategoryOption } from "./api";
import { pathKey, supplierCategoryTree } from "./supplier-categories";
import { text } from "./text";

// A select shows no tree: a node is indented by its depth
const INDENT = "   ";
const PATH_SEPARATOR = " > ";

interface SupplierCategoryPickerProps {
  source: { code: string; name: string };
  options: CategoryOption[];
  chosen: CategoryFilter[];
  onChange: (chosen: CategoryFilter[]) => void;
}

// The one chosen supplier's own tree, beside the shared categories (Filters.tsx). As there, a node is picked, then
// added with the button: a select that added on change would add every option the arrow keys pass on Windows.
export function SupplierCategoryPicker({ source, options, chosen, onChange }: SupplierCategoryPickerProps) {
  const [picked, setPicked] = useState("");
  const selectId = useId();
  const hintId = useId();
  const nodes = useMemo(() => supplierCategoryTree(options, source.code), [options, source.code]);
  const chosenKeys = new Set(chosen.map((each) => pathKey(each.path)));

  const add = () => {
    const node = nodes.find((each) => pathKey(each.path) === picked);
    if (node && !chosenKeys.has(picked)) onChange([...chosen, { source: source.code, path: node.path }]);
    setPicked("");
  };

  if (!nodes.length) return null;
  return (
    <div className="panel-block">
      <label htmlFor={selectId} className="label">{text.filters.supplierCategories(source.name)}</label>
      <div className="pick">
        <select id={selectId} value={picked} aria-describedby={hintId} onChange={(event) => setPicked(event.target.value)}>
          <option value="">{text.filters.pickSupplierCategory}</option>
          {nodes.map((node) => {
            const key = pathKey(node.path);
            return (
              <option key={key} value={key} disabled={chosenKeys.has(key)}>
                {INDENT.repeat(node.depth) + text.filters.category(node.path.at(-1) ?? "", node.models)}
              </option>
            );
          })}
        </select>
        <button type="button" disabled={!picked} onClick={add}>{text.filters.addCategory}</button>
      </div>
      {chosen.length > 0 && (
        <ul className="chips">
          {chosen.map((each) => {
            const name = each.path.join(PATH_SEPARATOR);
            return (
              <li key={pathKey(each.path)} className="chip" lang="en">
                {name}
                <button
                  type="button"
                  lang="uk"
                  aria-label={text.filters.removeCategory(name)}
                  onClick={() => onChange(chosen.filter((other) => other !== each))}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p id={hintId} className="hint">{text.filters.supplierCategoriesHint}</p>
    </div>
  );
}
