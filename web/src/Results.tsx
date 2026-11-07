import { memo, useState } from "react";
import { type ConditionMatch, type Grade, removeGrade, type ResultVariant, type SearchResult, setGrade } from "./api";
import { askedMatches, gradeBody, photoSrc, variantSummary, withGrade } from "./format";
import { ModelLinks } from "./ModelLinks";
import { ResultGrade } from "./ResultGrade";
import type { ShownSearch } from "./SearchView";
import { formatNumber, priceSpanText, priceText, text } from "./text";
import type { OwnProducts } from "./useOwnProducts";
import "./results.css";

// Colours named in the card before the rest are counted
const SHOWN_COLORS = 4;

// Sizes and arrivals are often empty for a whole model (mugs, pens): their columns are left out then, so the table
// fits the card
function VariantTable({ variants }: { variants: ResultVariant[] }) {
  const columns = text.results.table;
  const hasSize = variants.some((variant) => variant.size);
  const hasArrival = variants.some((variant) => variant.nextArrival);
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{columns.sku}</th>
            <th>{columns.color}</th>
            {hasSize && <th>{columns.size}</th>}
            <th className="number">{columns.stock}</th>
            {hasArrival && <th>{columns.arrival}</th>}
            <th className="number">{columns.price}</th>
          </tr>
        </thead>
        <tbody>
          {variants.map((variant) => (
            <tr key={variant.sku}>
              <td>{variant.sku}</td>
              <td>{variant.color ?? ""}</td>
              {hasSize && <td>{variant.size ?? ""}</td>}
              <td className="number">{variant.inStock === null ? text.results.unknown : formatNumber(variant.inStock)}</td>
              {hasArrival && (
                <td>{variant.nextArrival ? text.results.arrival(variant.nextArrival.date, variant.nextArrival.quantity) : ""}</td>
              )}
              <td className="number">{variant.price ? priceText(variant.price) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The colour of the variant a SKU named, to compare with what the buyer asked for; a model's code names no colour
function matchedColor({ matchedCode, variants }: SearchResult): string | null {
  const sku = matchedCode?.toLowerCase();
  return variants.find((variant) => variant.sku.toLowerCase() === sku)?.color ?? null;
}

function ConditionMatches({ match }: { match: ConditionMatch }) {
  return (
    <ul className="card-conditions" aria-label={text.results.conditions}>
      {askedMatches(match).map(({ key, value }) => (
        <li key={key} className={`card-condition is-${value}`}>{text.results.condition(key, value)}</li>
      ))}
    </ul>
  );
}

interface ResultCardProps {
  result: SearchResult;
  own: OwnProducts;
  grade: Grade | null;
  onGrade: (grade: Grade | null) => Promise<void>;
}

function ResultCard({ result, own, grade, onGrade }: ResultCardProps) {
  const [photoIndex, setPhotoIndex] = useState(0);
  // A model has up to a hundred variants: their table is drawn once it is opened
  const [isOpen, setIsOpen] = useState(false);
  const photo = result.photos[photoIndex];
  const summary = variantSummary(result.variants);
  const hiddenColors = summary.colors.length - SHOWN_COLORS;
  return (
    <article className="card">
      <div className="card-photo">
        {photo ? (
          <a href={photoSrc(photo.urlLarge ?? photo.url)} target="_blank" rel="noreferrer" title={text.results.openPhoto}>
            <img src={photoSrc(photo.url)} alt={result.name ?? result.code} loading="lazy" referrerPolicy="no-referrer" />
          </a>
        ) : (
          <span className="hint">{text.results.noPhoto}</span>
        )}
        <span className="rank">{result.rank}</span>
      </div>
      {result.photos.length > 1 && (
        <div className="thumbs">
          {result.photos.map((each, index) => (
            <button
              key={each.id ?? each.url}
              type="button"
              className={index === photoIndex ? "thumb is-active" : "thumb"}
              aria-label={text.results.showPhoto(index + 1)}
              aria-pressed={index === photoIndex}
              onClick={() => setPhotoIndex(index)}
            >
              <img src={photoSrc(each.url)} alt="" loading="lazy" referrerPolicy="no-referrer" />
            </button>
          ))}
        </div>
      )}
      <p className="card-source">{result.source.name} · {result.code}</p>
      {result.pageUrl && (
        <a
          className="card-page"
          href={result.pageUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={text.results.supplierPageOf(result.name ?? result.code)}
        >
          {text.results.supplierPage}
        </a>
      )}
      {result.matchedCode && (
        <p className="card-match">{text.results.matchedCode(result.matchedCode, matchedColor(result), result.matchedCodeModels)}</p>
      )}
      <h3 className="card-name">{result.name ?? text.results.noName}</h3>
      {result.category.length > 0 && <p className="hint">{result.category.join(" > ")}</p>}
      {result.confidence && (
        <p className={`card-confidence is-${result.confidence.level}`}>
          {text.results.confidence(result.confidence.percent, result.confidence.level)}
        </p>
      )}
      {result.conditionMatch && <ConditionMatches match={result.conditionMatch} />}
      <p className="card-price">
        {summary.prices.length ? summary.prices.map(priceSpanText).join("; ") : text.results.noPrice}
      </p>
      <p>{summary.stock === null ? text.results.noStock : text.results.stock(summary.stock, summary.hasUnknownStock)}</p>
      <details onToggle={(event) => setIsOpen(event.currentTarget.open)}>
        <summary>
          {text.results.variants(summary.count)}
          {summary.colors.length > 0 && `: ${summary.colors.slice(0, SHOWN_COLORS).join(", ")}`}
          {hiddenColors > 0 && `, ${text.results.moreColors(hiddenColors)}`}
        </summary>
        {isOpen && <VariantTable variants={result.variants} />}
      </details>
      <ResultGrade modelName={result.name ?? result.code} grade={grade} onChange={onGrade} />
      <ModelLinks modelId={result.modelId} modelName={result.name ?? result.code} own={own} />
    </article>
  );
}

interface ResultsProps {
  results: SearchResult[];
  count: number;
  own: OwnProducts;
  search: ShownSearch;
}

// Memoized: typing in the query panel re-renders the page, not the cards (up to 100 of them)
export const Results = memo(function Results({ results, count, own, search }: ResultsProps) {
  // Here rather than in a card: a card a smaller count hides comes back with its grade. A new search draws this anew.
  const [grades, setGrades] = useState<ReadonlyMap<number, Grade>>(new Map());

  const changeGrade = async (result: SearchResult, grade: Grade | null) => {
    const { searchId, model } = search.response;
    if (grade) {
      const made = { text: search.query, hasPhoto: search.photo !== null, model, filters: search.filters };
      await setGrade(searchId, result.modelId, gradeBody(grade, made, result));
    } else {
      await removeGrade(searchId, result.modelId);
    }
    setGrades((current) => withGrade(current, result.modelId, grade));
  };

  if (!results.length) return <p className="note">{text.results.empty}</p>;
  return (
    <div className="grid">
      {results.slice(0, count).map((result) => (
        <ResultCard
          key={result.modelId}
          result={result}
          own={own}
          grade={grades.get(result.modelId) ?? null}
          onGrade={(grade) => changeGrade(result, grade)}
        />
      ))}
    </div>
  );
});
