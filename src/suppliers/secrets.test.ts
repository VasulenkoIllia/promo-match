import { describe, expect, it } from "vitest";
import { linkSecrets, REDACTED, scrub } from "./secrets.js";

describe("linkSecrets", () => {
  it("takes a presigned link and its AWS credentials, not its other parameters", () => {
    const link = new URL("https://b.s3.amazonaws.com/f.json?X-Amz-Security-Token=t%2F1&X-Amz-Credential=ASIA1%2F20261028"
      + "&X-Amz-Date=20261028&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abc&v=12345");
    expect(linkSecrets(link)).toEqual([link.href, "t/1", "ASIA1/20261028", "abc"]);
  });

  it("leaves a plain address readable", () => {
    expect(linkSecrets(new URL("https://axpol.com/api/b2b-api/"))).toEqual([]);
  });
});

describe("scrub", () => {
  it("replaces a secret in every form it can take in text", () => {
    const secret = 'pa"ss w/rd&~';
    const forms = [
      secret,
      JSON.stringify({ password: secret }),
      `?a=${encodeURIComponent(secret)}`,
      `?a=${encodeURIComponent(secret).toLowerCase()}`,
      new URLSearchParams({ a: secret }).toString(),
      "pa&quot;ss w/rd&amp;~",
    ];
    const result = scrub(forms.join("\n"), [secret]);
    expect(result).not.toMatch(/ss( |%20|\+)w/i);
  });

  it("replaces an API key in a URL and a bearer token whatever their values", () => {
    const result = scrub("GET /api/?uid=86&key=abc123 Authorization: Bearer eyJ.x.y", []);
    expect(result).toBe(`GET /api/?uid=86&key=${REDACTED} Authorization: Bearer ${REDACTED}`);
  });

  it("replaces the temporary AWS credentials of a presigned S3 link", () => {
    const link = "https://b.s3.amazonaws.com/f.json?X-Amz-Security-Token=abc%2Fdef&X-Amz-Signature=123"
      + "&AWSAccessKeyId=ASIA1&Signature=xyz&x-amz-security-token=t";
    expect(scrub(link, [])).toBe(`https://b.s3.amazonaws.com/f.json?X-Amz-Security-Token=${REDACTED}`
      + `&X-Amz-Signature=${REDACTED}&AWSAccessKeyId=${REDACTED}&Signature=${REDACTED}`
      + `&x-amz-security-token=${REDACTED}`);
  });

  it("replaces a longer secret whole when a shorter one sits inside it", () => {
    expect(scrub("link https://x/?u=user1&s=sig", ["user1", "https://x/?u=user1&s=sig"])).toBe(`link ${REDACTED}`);
  });

  it("leaves values too short to tell from data", () => {
    expect(scrub("uid 86, price 86.50", ["86"])).toBe("uid 86, price 86.50");
  });
});
