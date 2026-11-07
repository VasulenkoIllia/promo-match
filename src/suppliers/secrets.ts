// Secrets kept out of files, logs and the console: the values themselves (keys, password, login, JWT) and
// secret-looking patterns. Shared by the smoke test (scripts/smoke) and the import.
export const REDACTED = "<redacted>";
// Shorter values would also match ordinary data (a uid "86" inside a price)
const MIN_SECRET_CHARS = 4;
// Query parameters of a presigned S3 link that hold its credentials; the others (X-Amz-Date, X-Amz-Expires=3600,
// X-Amz-SignedHeaders=host) are ordinary words and numbers that would be scrubbed from every log line
const AWS_CREDENTIAL_PARAM = /^(?:x-amz-(?:credential|security-token|signature)|awsaccesskeyid|signature)$/i;
// Whatever the value: the key parameter of a URL (Axpol's API key), a bearer token and the temporary AWS credentials
// of a presigned S3 link (Midocean's products and stock)
const SECRET_PATTERNS: [RegExp, string][] = [
  [/([?&]key=)[^&\s"'<>]+/gi, `$1${REDACTED}`],
  [/(Bearer\s+)[\w.~+/=-]+/g, `$1${REDACTED}`],
  [/([?&](?:X-Amz-[A-Za-z-]+|AWSAccessKeyId|Signature)=)[^&\s"'<>]+/gi, `$1${REDACTED}`],
];

// How a secret can appear in text: as it is, escaped in JSON, encoded in a URL (either hex case, or as a form) and
// escaped in HTML
function secretForms(secret: string): Set<string> {
  const encoded = encodeURIComponent(secret);
  const html = secret.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  return new Set([
    secret,
    JSON.stringify(secret).slice(1, -1),
    encoded,
    encoded.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()),
    new URLSearchParams({ s: secret }).toString().slice(2),
    html,
  ]);
}

// Secret values (keys, password, login, JWT) and secret-looking patterns replaced in text bound for a file or the
// console
export function scrub(text: string, secrets: readonly string[]): string {
  let result = text;
  // Longest first: a login inside a presigned link must not cut the link into pieces no longer matched whole
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (secret.length < MIN_SECRET_CHARS) continue;
    for (const form of secretForms(secret)) result = result.replaceAll(form, REDACTED);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

// A redirect target with a query and the AWS credentials in it, so they are scrubbed in any form, e.g. echoed back
// inside an S3 XML error. A target without a query is a plain address (Axpol's new domain) and stays readable; other
// query values (an Axpol uid of a few digits) would also match ordinary data.
export function linkSecrets(link: URL): string[] {
  const credentials = [...link.searchParams].filter(([name]) => AWS_CREDENTIAL_PARAM.test(name)).map(([, value]) => value);
  return link.search ? [link.href, ...credentials] : credentials;
}
