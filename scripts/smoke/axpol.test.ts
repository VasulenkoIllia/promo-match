import { describe, expect, it } from "vitest";
import { axpolOutcome } from "./axpol.js";

describe("axpolOutcome", () => {
  it("is ok only for success 1 with HTTP 200", () => {
    expect(axpolOutcome(200, { success: 1, message: "", data: {} })).toBe("ok");
    expect(axpolOutcome(200, { success: "1", message: "", data: {} })).toBe("ok");
  });

  it("is rejected when Axpol answers without success, with or without data", () => {
    expect(axpolOutcome(200, { success: 0, message: "Wrong key", data: [] })).toBe("rejected");
    expect(axpolOutcome(200, { success: 0, message: "Wrong password" })).toBe("rejected");
    expect(axpolOutcome(401, undefined)).toBe("rejected");
    expect(axpolOutcome(403, { error: "invalid credentials" })).toBe("rejected");
  });

  it("is refused for a firewall status without JSON or a 200 that is not JSON", () => {
    expect(axpolOutcome(403, undefined)).toBe("refused");
    expect(axpolOutcome(200, undefined)).toBe("refused");
  });

  it("is unreachable without an answer, on a redirect, a missing endpoint or 5xx", () => {
    expect(axpolOutcome(undefined, undefined)).toBe("unreachable");
    expect(axpolOutcome(301, undefined)).toBe("unreachable");
    expect(axpolOutcome(404, { error: "not found" })).toBe("unreachable");
    expect(axpolOutcome(502, undefined)).toBe("unreachable");
  });
});
