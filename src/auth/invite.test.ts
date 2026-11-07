import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canManageUsers, isLinkUsable, LINK_HOURS, LINK_TOKEN_PATTERN, type LinkRow, newLink } from "./invite.js";

const NOW = new Date("2026-11-07T10:00:00Z");
const HOUR_MS = 3_600_000;

describe("newLink", () => {
  it("makes a long random token the schema takes, and keeps only its sha256 for the database", () => {
    const link = newLink(NOW);
    expect(link.token).toMatch(new RegExp(LINK_TOKEN_PATTERN));
    expect(link.tokenHash).toBe(createHash("sha256").update(link.token).digest("hex"));
    expect(link.tokenHash).not.toContain(link.token);
    expect(newLink(NOW).token).not.toBe(link.token);
  });

  it("ends 72 hours after it is made", () => {
    expect(LINK_HOURS).toBe(72);
    expect(newLink(NOW).expiresAt.getTime() - NOW.getTime()).toBe(72 * HOUR_MS);
  });
});

describe("isLinkUsable", () => {
  const link: LinkRow = {
    kind: "invite", usedAt: null, expiresAt: new Date(NOW.getTime() + HOUR_MS), createdBy: { isActive: true, role: "admin" },
  };

  it("takes a link not used, before its end, of the kind the page asks for", () => {
    expect(isLinkUsable(link, "invite", NOW)).toBe(true);
  });

  it("takes a link once: a used one is not usable", () => {
    expect(isLinkUsable({ ...link, usedAt: NOW }, "invite", NOW)).toBe(false);
  });

  it("stops at its end, not a moment after", () => {
    expect(isLinkUsable(link, "invite", new Date(link.expiresAt.getTime() - 1))).toBe(true);
    expect(isLinkUsable(link, "invite", link.expiresAt)).toBe(false);
  });

  it("does not open the other page: an invite sets no password, a reset makes no user", () => {
    expect(isLinkUsable(link, "reset", NOW)).toBe(false);
    expect(isLinkUsable({ ...link, kind: "reset" }, "invite", NOW)).toBe(false);
  });

  it("stops when the admin who made it is disabled or is no admin", () => {
    expect(isLinkUsable({ ...link, createdBy: { isActive: false, role: "admin" } }, "invite", NOW)).toBe(false);
    expect(isLinkUsable({ ...link, createdBy: { isActive: true, role: "manager" } }, "invite", NOW)).toBe(false);
  });
});

describe("canManageUsers", () => {
  it("is the admin's alone", () => {
    expect(canManageUsers("admin")).toBe(true);
    expect(canManageUsers("manager")).toBe(false);
  });
});
