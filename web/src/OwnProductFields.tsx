import { useId } from "react";
import type { NewOwnProduct } from "./api";
import { text } from "./text";

// The API's bounds (src/own-products/request.ts)
const MAX_NAME_CHARS = 200;
const MAX_CODE_CHARS = 60;

export const EMPTY_FIELDS: NewOwnProduct = { name: "", code: "" };

interface OwnProductFieldsProps {
  value: NewOwnProduct;
  onChange: (next: NewOwnProduct) => void;
}

// The fields of a new own product: on its tab and in the link form of a card
export function OwnProductFields({ value, onChange }: OwnProductFieldsProps) {
  const ids = { name: useId(), code: useId(), codeHint: useId() };
  return (
    <>
      <div className="panel-block">
        <label htmlFor={ids.name} className="label">{text.own.name}</label>
        <input
          id={ids.name}
          type="text"
          required
          maxLength={MAX_NAME_CHARS}
          value={value.name}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
      </div>
      <div className="panel-block">
        <label htmlFor={ids.code} className="label">{text.own.code}</label>
        <input
          id={ids.code}
          type="text"
          maxLength={MAX_CODE_CHARS}
          value={value.code}
          aria-describedby={ids.codeHint}
          onChange={(event) => onChange({ ...value, code: event.target.value })}
        />
        <p id={ids.codeHint} className="hint">{text.own.codeHint}</p>
      </div>
    </>
  );
}
