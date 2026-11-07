import { MS_PER_SECOND } from "../../src/suppliers/http.js";
import { isRecord } from "../../src/suppliers/normalize.js";
import {
  type Feed, FEED_MAX_BYTES, FEED_TIMEOUT_MS, feedPlanLines, feedUrl, jsonLogin, photoPlanLine, probeFirstPhoto, readFeed,
  skipFeeds,
} from "./feeds.js";
import { BYTES_PER_MB, type Run } from "./run.js";

// Makito API B2B (https://data.makito.es/apis_b2b/): a JSON login for a JWT, then full files of each feed. Orders
// (/orders*) are never called.
const MAKITO_BASE = "https://apis.makito.es";
const LOGIN_URL = feedUrl(MAKITO_BASE, "/access/auth/login");

const MAKITO_FEEDS: Feed[] = [
  { name: "catalog", url: feedUrl(MAKITO_BASE, "/catalog/files", { format: "JSON", lang: "en" }), isRequired: true },
  {
    name: "catalog-theinfinite",
    url: feedUrl(MAKITO_BASE, "/catalog/files", { format: "JSON", lang: "en", catalog: "THEINFINITE_CATALOG" }),
    isRequired: false,
  },
  { name: "stock", url: feedUrl(MAKITO_BASE, "/stock/files", { format: "JSON" }), isRequired: true },
  { name: "price-list", url: feedUrl(MAKITO_BASE, "/price-list/files", { format: "JSON" }), isRequired: true },
  { name: "print-config", url: feedUrl(MAKITO_BASE, "/print-config/files", { format: "JSON", lang: "en" }), isRequired: true },
  { name: "print-price-list", url: feedUrl(MAKITO_BASE, "/print-price-list/files", { format: "JSON" }), isRequired: true },
];

export function makitoPlan(): string[] {
  return [
    `Makito, POST ${LOGIN_URL.href} with clientId and clientSecret, then Authorization: Bearer;`
      + ` timeout ${FEED_TIMEOUT_MS / MS_PER_SECOND} s, body up to ${FEED_MAX_BYTES / BYTES_PER_MB} MB, each file kept whole:`,
    ...feedPlanLines(MAKITO_FEEDS),
    photoPlanLine(),
    `  if it does not open and is on ${MAKITO_BASE}: once more with the token`,
  ];
}

export async function runMakito(run: Run): Promise<void> {
  const token = await jsonLogin(
    run, "makito", "login", LOGIN_URL,
    { clientId: run.env.makitoClientId, clientSecret: run.env.makitoClientSecret },
    (json) => (isRecord(json) ? json.token : undefined),
  );
  if (!token) {
    skipFeeds(run, "makito", MAKITO_FEEDS, "login failed");
    return;
  }
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  let catalog: unknown;
  for (const feed of MAKITO_FEEDS) {
    const json = await readFeed(run, "makito", feed, headers);
    if (feed.name === "catalog") catalog = json;
  }
  if (catalog === undefined) return;
  const photo = await probeFirstPhoto(run, "makito", catalog);
  // The token goes to Makito's own origin only: https and its host, never plain http
  if (!photo.isOk && photo.url?.origin === MAKITO_BASE) {
    await probeFirstPhoto(run, "makito", catalog, { Authorization: `Bearer ${token}` }, "photo-with-token");
  }
}
