// Passwords of stage 7 (docs/integrations.md, «Логін»): scrypt of node:crypto at OWASP's settings. The stored value holds
// its parameters and salt, so they can rise later without a migration and old hashes still verify.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const ALGORITHM = "scrypt";
// N 2^15, r 8, p 3: 32 MiB per hash, so the four threads of Node's pool hold at most 128 MiB however many logins come
const COST = { N: 2 ** 15, r: 8, p: 3 };
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const BLOCK_BYTES = 128;
const HASH_PARTS = 6;
const SEPARATOR = "$";

interface Cost {
  N: number;
  r: number;
  p: number;
}

function derive(password: string, salt: Buffer, cost: Cost, keyBytes: number): Promise<Buffer> {
  // Node's default maxmem is exactly what this N needs, and it refuses that: twice over leaves room for the working blocks
  const maxmem = 2 * BLOCK_BYTES * cost.N * cost.r;
  return new Promise((resolve, reject) => {
    // NFKC: the same password typed on another system may reach us with its letters composed differently
    scrypt(password.normalize("NFKC"), salt, keyBytes, { ...cost, maxmem }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST, KEY_BYTES);
  return [ALGORITHM, COST.N, COST.r, COST.p, salt.toString("base64"), key.toString("base64")].join(SEPARATOR);
}

// A value of another shape is a broken row, not a wrong password: it throws, and the sign-in answers 500
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(SEPARATOR);
  const [algorithm, N, r, p, salt, key] = parts;
  if (parts.length !== HASH_PARTS || algorithm !== ALGORITHM || !salt || !key) {
    throw new Error("a stored password hash of an unknown shape");
  }
  const expected = Buffer.from(key, "base64");
  const derived = await derive(password, Buffer.from(salt, "base64"), { N: Number(N), r: Number(r), p: Number(p) }, expected.length);
  return timingSafeEqual(derived, expected);
}
