import { MS_PER_SECOND } from "../../src/suppliers/http.js";
import { isRecord } from "../../src/suppliers/normalize.js";
import {
  type Feed, FEED_MAX_BYTES, FEED_TIMEOUT_MS, feedPlanLines, feedUrl, jsonLogin, photoPlanLine, probeFirstPhoto, readFeed,
  skipFeeds,
} from "./feeds.js";
import { BYTES_PER_MB, type Run } from "./run.js";

// Blue Collection (Asgard) API (https://developers.bluecollection.eu/en/): username and password for a JWT pair, the
// access token lives 5 minutes and the refresh token a day. Orders (/api/orders/) are never called.
const BLUECOLLECTION_BASE = "https://developers.bluecollection.eu";
const TOKEN_URL = feedUrl(BLUECOLLECTION_BASE, "/api/token/");
const REFRESH_URL = feedUrl(BLUECOLLECTION_BASE, "/api/token/refresh/");
// A minute before the documented 5 minutes, so a long read does not start on a token about to expire
const ACCESS_RENEW_AFTER_MS = 4 * 60 * MS_PER_SECOND;

const BLUECOLLECTION_FEEDS: Feed[] = [
  { name: "products-index", url: feedUrl(BLUECOLLECTION_BASE, "/api/products-index/"), isRequired: true },
  // The same products with the purchase price of the account
  { name: "client-products", url: feedUrl(BLUECOLLECTION_BASE, "/api/client-products/"), isRequired: false },
  { name: "stock-info", url: feedUrl(BLUECOLLECTION_BASE, "/api/stock-info/"), isRequired: true },
  { name: "marking-data", url: feedUrl(BLUECOLLECTION_BASE, "/api/marking-data/"), isRequired: false },
  { name: "last-update", url: feedUrl(BLUECOLLECTION_BASE, "/api/last-update/"), isRequired: false },
];

export function bluecollectionPlan(): string[] {
  return [
    `Blue Collection, POST ${TOKEN_URL.href} with username and password, then Authorization: Bearer; the access`
      + ` token renewed at ${REFRESH_URL.href} after ${ACCESS_RENEW_AFTER_MS / MS_PER_SECOND} s;`
      + ` timeout ${FEED_TIMEOUT_MS / MS_PER_SECOND} s, body up to ${FEED_MAX_BYTES / BYTES_PER_MB} MB; the lists are`
      + " paged by 100 (count, next), only the first page is read and kept:",
    ...feedPlanLines(BLUECOLLECTION_FEEDS),
    photoPlanLine(),
  ];
}

const accessOf = (json: unknown) => (isRecord(json) ? json.access : undefined);

export async function runBluecollection(run: Run): Promise<void> {
  const refresh = { value: undefined as string | undefined };
  let access = await jsonLogin(
    run, "bluecollection", "token", TOKEN_URL,
    { username: run.env.bluecollectionUsername, password: run.env.bluecollectionPassword },
    (json) => {
      if (isRecord(json) && typeof json.refresh === "string") refresh.value = json.refresh;
      return accessOf(json);
    },
  );
  if (!access) {
    skipFeeds(run, "bluecollection", BLUECOLLECTION_FEEDS, "login failed");
    return;
  }
  let issuedAtMs = Date.now();
  let catalog: unknown;
  for (const [index, feed] of BLUECOLLECTION_FEEDS.entries()) {
    if (Date.now() - issuedAtMs > ACCESS_RENEW_AFTER_MS && refresh.value) {
      access = await jsonLogin(run, "bluecollection", "token refresh", REFRESH_URL, { refresh: refresh.value }, accessOf);
      if (!access) {
        skipFeeds(run, "bluecollection", BLUECOLLECTION_FEEDS.slice(index), "token renewal failed");
        return;
      }
      issuedAtMs = Date.now();
    }
    const json = await readFeed(run, "bluecollection", feed, { Authorization: `Bearer ${access}`, Accept: "application/json" });
    if (feed.name === "products-index") catalog = json;
  }
  if (catalog !== undefined) await probeFirstPhoto(run, "bluecollection", catalog);
}
