import { describe, expect, it } from "vitest";
import { linkPageOf, linkUrl } from "./links";

const TOKEN = "Ab3_-".padEnd(43, "x");

describe("linkPageOf", () => {
  it("reads the kind from the path and the token from after #", () => {
    expect(linkPageOf("/invite", `#${TOKEN}`)).toEqual({ kind: "invite", token: TOKEN });
    expect(linkPageOf("/reset/", `#${TOKEN}`)).toEqual({ kind: "reset", token: TOKEN });
  });

  it("knows the page without a whole token, as after a reload", () => {
    expect(linkPageOf("/invite", "")).toEqual({ kind: "invite", token: null });
    expect(linkPageOf("/invite", "#short")).toEqual({ kind: "invite", token: null });
    expect(linkPageOf("/reset", `#${TOKEN}x`)).toEqual({ kind: "reset", token: null });
  });

  it("is null for the app's own pages", () => {
    expect(linkPageOf("/", `#${TOKEN}`)).toBeNull();
    expect(linkPageOf("/invites", `#${TOKEN}`)).toBeNull();
  });
});

describe("linkUrl", () => {
  it("puts the token after #, where no server sees it, and is read back", () => {
    const url = new URL(linkUrl("https://app.example.com", "reset", TOKEN));
    expect(url.search).toBe("");
    expect(linkPageOf(url.pathname, url.hash)).toEqual({ kind: "reset", token: TOKEN });
  });
});
