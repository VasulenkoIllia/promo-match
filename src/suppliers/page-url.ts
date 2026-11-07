// The page of a product on its supplier's site. No feed gives one (every value of every feed read on 2026-11-01,
// docs/integrations.md, «Сторінка товару»): the addresses follow the sites' own rule, which neither supplier promises.
// Only built here and opened by a person: the sites are not read.

export interface PagedVariant {
  sku: string;
  // Midocean's variant_id
  externalId: string | null;
}

const PAGE_RULES = new Map<string, (variant: PagedVariant) => string | null>([
  // V2389/A-11 lives at v2389a-11.html, P762.649 at p762649.html. The Polish site, since the English one answers 404 to
  // the P and T codes; 93 of 101 models opened on 2026-11-01, the rest have an address of their own or left the site.
  ["axpol", ({ sku }) => `https://axpol.com/pl/search/${encodeURIComponent(sku.toLowerCase().replaceAll(/[./]/g, ""))}.html`],
  // Without a region the site picks one and adds the category path
  ["midocean", ({ sku, externalId }) => (externalId
    ? `https://www.midocean.com/${encodeURIComponent(sku.toLowerCase())}-zid${encodeURIComponent(externalId)}` : null)],
]);

// null: a source with no such rule, or a variant the rule cannot name
export function supplierPageUrl(sourceCode: string, variant: PagedVariant): string | null {
  return PAGE_RULES.get(sourceCode)?.(variant) ?? null;
}
