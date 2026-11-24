// The page of a product on its supplier's site. No feed gives one (every value of every feed read on 2026-11-01,
// docs/integrations.md, «Сторінка товару»): the addresses follow the sites' own rule, which no supplier promises.
// Only built here and opened by a person: the sites are not read.

export interface PagedVariant {
  sku: string;
  // Midocean's variant_id
  externalId: string | null;
}

type PageRule = (modelCode: string, variant: PagedVariant) => string | null;

const PAGE_RULES = new Map<string, PageRule>([
  // V2389/A-11 lives at v2389a-11.html, P762.649 at p762649.html. The German site, as the catalogue is read from it
  // (owner's decision 2026-11-23): 30 of 31 variants opened on 2026-11-23, the English and Polish sites 29, short of
  // an HE code only the German one has.
  ["axpol", (_model, { sku }) => `https://axpol.com/de/search/${encodeURIComponent(sku.toLowerCase().replaceAll(/[./]/g, ""))}.html`],
  // Without a region the site picks one and adds the category path
  ["midocean", (_model, { sku, externalId }) => (externalId
    ? `https://www.midocean.com/${encodeURIComponent(sku.toLowerCase())}-zid${encodeURIComponent(externalId)}` : null)],
  // The shop names a product by the model's code (web_reference); 15 of 15 opened on 2026-11-23
  ["makito", (model) => `https://makito.es/epages/Makito.sf/en_GB/?ObjectPath=/Shops/Makito/Products/${encodeURIComponent(model)}`],
  // A page per variant (article_id), the German region in English as the stock is the German one; 15 of 15 opened
  ["inspirion", (_model, { sku }) => `https://www.inspirion.eu/de-en/product/${encodeURIComponent(sku)}`],
  // No address of its own in the feed: the site's search by the variant's code sends to its page, 15 of 15
  ["macma", (_model, { sku }) => `https://www.macma.de/en/search?search=${encodeURIComponent(sku)}`],
]);

// null: a source with no such rule, or a variant the rule cannot name
export function supplierPageUrl(sourceCode: string, modelCode: string, variant: PagedVariant): string | null {
  return PAGE_RULES.get(sourceCode)?.(modelCode, variant) ?? null;
}
