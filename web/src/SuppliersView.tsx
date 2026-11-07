import { useEffect, useId, useState } from "react";
import { ErrorNote } from "./SearchView";
import { fetchSuppliers, type SupplierStatus, type SuppliersOverview } from "./suppliers-api";
import {
  categoryLines, catalogLines, type CellLine, importLines, stockLines, suppliersErrorText, suppliersText, vectorLines,
} from "./suppliers-text";
import { type ErrorText, errorTextFor } from "./text";
import "./suppliers.css";

type OverviewState =
  | { kind: "loading" }
  | { kind: "ok"; overview: SuppliersOverview; readAt: string }
  | { kind: "error"; error: ErrorText };

// In the order of the table's columns
const CELLS: [string, (supplier: SupplierStatus) => CellLine[]][] = [
  ["catalog", catalogLines], ["import", importLines], ["stock", stockLines], ["vectors", vectorLines],
  ["categories", categoryLines],
];

function Cell({ lines }: { lines: CellLine[] }) {
  return (
    <td>
      <ul className="cell-lines">
        {lines.map((each) => (
          <li key={each.text} className={each.isWarn ? "is-warn" : undefined}>{each.text}</li>
        ))}
      </ul>
    </td>
  );
}

function SupplierTable({ overview }: { overview: SuppliersOverview }) {
  const { columns } = suppliersText;
  if (!overview.suppliers.length) return <p className="hint">{suppliersText.empty}</p>;
  return (
    <table className="suppliers">
      <thead>
        <tr>
          <th scope="col">{columns.name}</th>
          <th scope="col">{columns.catalog}</th>
          <th scope="col">{columns.import}</th>
          <th scope="col">{columns.stock}</th>
          <th scope="col">{columns.vectors}</th>
          <th scope="col">{columns.categories}</th>
        </tr>
      </thead>
      <tbody>
        {overview.suppliers.map((supplier) => (
          <tr key={supplier.code}>
            <th scope="row">{supplier.name}</th>
            {CELLS.map(([key, lines]) => <Cell key={key} lines={lines(supplier)} />)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// For an admin and a manager alike (Shell.tsx). Mounted when it is opened, so the state is read fresh each time; the
// server reads the counts the workers would (src/suppliers/overview.ts).
export function SuppliersView() {
  const [state, setState] = useState<OverviewState>({ kind: "loading" });
  const [loads, setLoads] = useState(0);
  const headingId = useId();

  useEffect(() => {
    const controller = new AbortController();
    fetchSuppliers(controller.signal)
      .then((overview) => setState({ kind: "ok", overview, readAt: new Date().toISOString() }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ kind: "error", error: errorTextFor(error, suppliersErrorText) });
      });
    return () => controller.abort();
  }, [loads]);

  const reload = () => {
    setState({ kind: "loading" });
    setLoads((count) => count + 1);
  };

  return (
    <main className="suppliers-page" aria-labelledby={headingId}>
      <div className="results-head">
        <h1 id={headingId}>{suppliersText.heading}</h1>
        <div className="row">
          {state.kind === "ok" && <span className="summary">{suppliersText.readAt(state.readAt)}</span>}
          <button type="button" disabled={state.kind === "loading"} onClick={reload}>{suppliersText.refresh}</button>
        </div>
      </div>
      {state.kind === "loading" && <p className="hint">{suppliersText.loading}</p>}
      {state.kind === "error" && (
        <ErrorNote error={state.error}>
          <button type="button" onClick={reload}>{suppliersText.retry}</button>
        </ErrorNote>
      )}
      {state.kind === "ok" && (
        <>
          <SupplierTable overview={state.overview} />
          <div className="suppliers-hints">
            {suppliersText.hints(state.overview.model).map((hint) => <p key={hint} className="hint">{hint}</p>)}
          </div>
        </>
      )}
    </main>
  );
}
