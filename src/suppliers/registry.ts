// The suppliers the import knows, each built from its .env keys when it is asked for. A new supplier is a module of
// its own (src/suppliers/<code>/) and a line here.
import { required } from "../config.js";
import { axpolAdapter } from "./axpol/adapter.js";
import { bluecollectionAdapter } from "./bluecollection/adapter.js";
import { inspirionAdapter } from "./inspirion/adapter.js";
import { easygiftsAdapter, macmaAdapter } from "./macma/adapter.js";
import { FEED_URL_VARIABLES, feedUrl } from "./macma/api.js";
import { ArchiveReader, archivePhotoFetch } from "./macma/archive.js";
import type { UrlFetch } from "./http.js";
import { makitoAdapter } from "./makito/adapter.js";
import { type Credentials, MakitoSession, makitoPhotoFetch } from "./makito/api.js";
import { midoceanAdapter } from "./midocean/adapter.js";
import type { SupplierAdapter } from "./types.js";

export const SUPPLIER_CODES = ["axpol", "midocean", "inspirion", "bluecollection", "makito", "macma", "easygifts"] as const;
export type SupplierCode = (typeof SUPPLIER_CODES)[number];
// Read only with --only: the feeds of Macma and Easy Gifts are read once for the demo (owner's decision 2026-11-05)
const ONE_OFF_CODES: ReadonlySet<SupplierCode> = new Set(["macma", "easygifts"]);
export const DEFAULT_IMPORT_CODES = SUPPLIER_CODES.filter((code) => !ONE_OFF_CODES.has(code));

export function isSupplierCode(value: string): value is SupplierCode {
  return (SUPPLIER_CODES as readonly string[]).includes(value);
}

export function adapterFor(code: SupplierCode): SupplierAdapter {
  switch (code) {
    case "axpol":
      return axpolAdapter({
        login: required("AXPOL_LOGIN"), password: required("AXPOL_PASSWORD"), apiKey: required("AXPOL_API_KEY"),
      });
    case "midocean":
      return midoceanAdapter(required("MIDOCEAN_API_KEY"));
    case "inspirion":
      return inspirionAdapter(required("INSPIRION_API_KEY"));
    case "bluecollection":
      return bluecollectionAdapter({
        username: required("BLUECOLLECTION_USERNAME"), password: required("BLUECOLLECTION_PASSWORD"),
      });
    case "makito":
      return makitoAdapter(makitoCredentials());
    case "macma":
      return macmaAdapter(feedUrl(FEED_URL_VARIABLES.macma, required(FEED_URL_VARIABLES.macma)));
    case "easygifts":
      return easygiftsAdapter(feedUrl(FEED_URL_VARIABLES.easygifts, required(FEED_URL_VARIABLES.easygifts)));
  }
}

export function makitoCredentials(): Credentials {
  return { clientId: required("MAKITO_CLIENT_ID"), clientSecret: required("MAKITO_CLIENT_SECRET") };
}

// How the embeddings fetch a source's photos: Makito's answer 401 without its token, those of Macma and Easy Gifts are
// entries of a ZIP archive, the others are public. Built for that source only, so a run of another one needs no Makito keys.
export function photoFetchFor(code: string, secrets: string[]): UrlFetch | undefined {
  if (code === "macma" || code === "easygifts") return archivePhotoFetch(new ArchiveReader());
  return code === "makito" ? makitoPhotoFetch(new MakitoSession(makitoCredentials(), secrets)) : undefined;
}
