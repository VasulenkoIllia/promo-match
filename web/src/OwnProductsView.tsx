import { type SubmitEvent, useId, useState } from "react";
import type { LinkedModel, NewOwnProduct, OwnProductEntry } from "./api";
import { EMPTY_FIELDS, OwnProductFields } from "./OwnProductFields";
import { ErrorNote } from "./SearchView";
import { type ErrorText, linkTypeName, text } from "./text";
import { ownProductErrorOf, type OwnProducts } from "./useOwnProducts";
import "./own-products.css";

function CreateForm({ own }: { own: OwnProducts }) {
  const [fields, setFields] = useState(EMPTY_FIELDS);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<ErrorText | null>(null);

  const changeFields = (next: NewOwnProduct) => {
    setFields(next);
    setError(null);
  };

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsPending(true);
    setError(null);
    try {
      await own.create(fields);
      setFields(EMPTY_FIELDS);
    } catch (caught) {
      setError(ownProductErrorOf(caught));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <form className="query-panel" onSubmit={(event) => void submit(event)}>
      <h1>{text.own.newHeading}</h1>
      <OwnProductFields value={fields} onChange={changeFields} />
      {error && <ErrorNote error={error} />}
      <div className="submit">
        <button type="submit" className="primary" disabled={isPending || !fields.name.trim()}>
          {isPending ? text.own.creating : text.own.create}
        </button>
      </div>
    </form>
  );
}

interface LinkedModelRowProps {
  ownProductId: number;
  model: LinkedModel;
  own: OwnProducts;
}

function LinkedModelRow({ ownProductId, model, own }: LinkedModelRowProps) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<ErrorText | null>(null);
  const title = model.name ?? text.results.noName;

  // On success the row is gone: its state stays set only on a failure
  const unlink = async () => {
    setIsPending(true);
    setError(null);
    try {
      await own.unlink(ownProductId, model.modelId);
    } catch (caught) {
      setError(ownProductErrorOf(caught));
      setIsPending(false);
    }
  };

  return (
    <li className="own-model">
      <div className="own-model-photo">
        {model.photoUrl
          ? <img src={model.photoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
          : <span className="hint">{text.results.noPhoto}</span>}
      </div>
      <div className="own-model-text">
        <p className="card-source">{model.source.name} · {model.code}</p>
        <p className="own-model-name">{title}</p>
        {!model.isActive && <p className="error-text">{text.own.notInCatalog}</p>}
        {error && <ErrorNote error={error} />}
      </div>
      <span className={`own-mark ${model.type}`}>{linkTypeName(model.type)}</span>
      <button
        type="button"
        disabled={isPending}
        aria-label={text.own.unlinkModel(title)}
        onClick={() => void unlink()}
      >
        {text.own.unlink}
      </button>
    </li>
  );
}

function ProductSection({ product, own }: { product: OwnProductEntry; own: OwnProducts }) {
  return (
    <section className="own-product">
      <h3>
        {product.name}
        {product.code && <span className="own-product-code">{product.code}</span>}
      </h3>
      {product.links.length ? (
        <ul className="own-models">
          {product.links.map((model) => (
            <LinkedModelRow key={model.modelId} ownProductId={product.id} model={model} own={own} />
          ))}
        </ul>
      ) : (
        <p className="hint">{text.own.noLinks}</p>
      )}
    </section>
  );
}

function OwnProductList({ own }: { own: OwnProducts }) {
  const { list } = own;
  if (list.kind === "loading") return <p className="hint">{text.own.loading}</p>;
  if (list.kind === "error") {
    return (
      <ErrorNote error={list.error}>
        <button type="button" onClick={own.retryList}>{text.own.retry}</button>
      </ErrorNote>
    );
  }
  if (!list.products.length) return <p className="note">{text.own.empty}</p>;
  return (
    <>
      {!list.isComplete && <p className="note warn">{text.own.incomplete}</p>}
      {list.products.map((product) => <ProductSection key={product.id} product={product} own={own} />)}
    </>
  );
}

export function OwnProductsView({ own }: { own: OwnProducts }) {
  const headingId = useId();
  return (
    <div className="layout">
      <CreateForm own={own} />
      <main className="results" aria-labelledby={headingId}>
        <h2 id={headingId} className="visually-hidden">{text.own.heading}</h2>
        <OwnProductList own={own} />
      </main>
    </div>
  );
}
