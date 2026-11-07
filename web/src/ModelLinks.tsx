import { type SubmitEvent, useId, useRef, useState } from "react";
import type { LinkType, ModelLink, NewOwnProduct } from "./api";
import { EMPTY_FIELDS, OwnProductFields } from "./OwnProductFields";
import { linkTypeName, text } from "./text";
import { ownProductErrorOf, type OwnProducts } from "./useOwnProducts";
import "./own-products.css";

// The value of the option that makes a new own product; the others are ids
const NEW_PRODUCT = "new";
const LINK_TYPES: LinkType[] = ["same", "analog"];

interface LinkFormProps {
  modelId: number;
  // For the form's accessible name: the cards show up to 100 of these forms
  modelName: string;
  links: ModelLink[];
  own: OwnProducts;
  onClose: () => void;
}

function LinkForm({ modelId, modelName, links, own, onClose }: LinkFormProps) {
  const { list } = own;
  const products = list.kind === "ok" ? list.products : [];
  const [picked, setPicked] = useState("");
  const [fields, setFields] = useState(EMPTY_FIELDS);
  const [type, setType] = useState<LinkType>("same");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { product: useId(), type: useId() };
  // With no own products yet, a new one is the only choice; while the list is not read, that is not known
  const hasNoProducts = list.kind === "ok" && !products.length;
  const choice = picked || (hasNoProducts ? NEW_PRODUCT : "");
  const isNew = choice === NEW_PRODUCT;
  const canSubmit = isNew ? Boolean(fields.name.trim()) : Boolean(choice);

  // A product the model is linked to already offers its type, so that sending the form does not flip it unnoticed
  const pick = (value: string) => {
    setPicked(value);
    setError(null);
    const linked = links.find((link) => String(link.ownProductId) === value);
    if (linked) setType(linked.type);
  };

  const changeFields = (next: NewOwnProduct) => {
    setFields(next);
    setError(null);
  };

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsPending(true);
    setError(null);
    try {
      const ownProductId = isNew ? (await own.create(fields)).id : Number(choice);
      // A link that fails next must not make the product a second time
      setPicked(String(ownProductId));
      await own.link(ownProductId, modelId, type);
      onClose();
    } catch (caught) {
      setError(ownProductErrorOf(caught).message);
      setIsPending(false);
    }
  };

  return (
    <form className="own-form" aria-label={text.own.linkModel(modelName)} onSubmit={(event) => void submit(event)}>
      <div className="panel-block">
        <label htmlFor={ids.product} className="label">{text.own.product}</label>
        <select id={ids.product} autoFocus value={choice} onChange={(event) => pick(event.target.value)}>
          {!hasNoProducts && <option value="">{text.own.pickProduct}</option>}
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {text.own.option(product, links.find((link) => link.ownProductId === product.id)?.type)}
            </option>
          ))}
          <option value={NEW_PRODUCT}>{text.own.newProduct}</option>
        </select>
        {list.kind === "loading" && <p className="hint">{text.own.loading}</p>}
        {list.kind === "error" && <p className="error-text">{list.error.message}</p>}
        {list.kind === "ok" && !list.isComplete && <p className="hint">{text.own.incomplete}</p>}
      </div>
      {isNew && <OwnProductFields value={fields} onChange={changeFields} />}
      <fieldset className="panel-block">
        <legend>{text.own.linkType}</legend>
        {LINK_TYPES.map((each) => (
          <label key={each} className="check">
            <input type="radio" name={ids.type} checked={type === each} onChange={() => setType(each)} />
            {linkTypeName(each)}
          </label>
        ))}
      </fieldset>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="row">
        <button type="submit" disabled={isPending || !canSubmit}>{isPending ? text.own.linking : text.own.link}</button>
        <button type="button" disabled={isPending} onClick={onClose}>{text.own.cancel}</button>
      </div>
    </form>
  );
}

interface ModelLinksProps {
  modelId: number;
  modelName: string;
  own: OwnProducts;
}

// On a result card: the own products the model is linked to, and the form that links it to one more
export function ModelLinks({ modelId, modelName, own }: ModelLinksProps) {
  const [isOpen, setIsOpen] = useState(false);
  const openButton = useRef<HTMLButtonElement>(null);
  const links = own.linksOfModels.get(modelId) ?? [];

  // The focus is inside the form, which goes: without this, the keyboard would start over from the top of the page
  const close = () => {
    setIsOpen(false);
    openButton.current?.focus();
  };

  return (
    <div className="own-links">
      {links.length > 0 && (
        <ul className="own-marks">
          {links.map((link) => (
            <li key={link.ownProductId} className={`own-mark ${link.type}`}>{text.own.linked(link.type, link.ownProductName)}</li>
          ))}
        </ul>
      )}
      <button
        ref={openButton}
        type="button"
        aria-expanded={isOpen}
        aria-label={text.own.linkModel(modelName)}
        onClick={() => setIsOpen(!isOpen)}
      >
        {text.own.linkOpen}
      </button>
      {isOpen && <LinkForm modelId={modelId} modelName={modelName} links={links} own={own} onClose={close} />}
    </div>
  );
}
