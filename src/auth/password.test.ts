import { scrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("passwords", () => {
  it("verifies the right password and no other", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterz", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("stores neither the password nor the same value twice", async () => {
    const [first, second] = await Promise.all([hashPassword("correct horse battery"), hashPassword("correct horse battery")]);
    expect(first).not.toBe(second);
    expect(first).not.toContain("correct");
    expect(first).toMatch(/^scrypt\$32768\$8\$3\$/);
  });

  it("verifies a hash made with other parameters, so they can rise later", async () => {
    const stored = await hashPassword("correct horse battery");
    const [, , , , salt] = stored.split("$");
    const key = await new Promise<Buffer>((resolve, reject) => {
      scrypt("correct horse battery", Buffer.from(salt ?? "", "base64"), 32, { N: 2 ** 14, r: 8, p: 1 }, (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      });
    });
    expect(await verifyPassword("correct horse battery", `scrypt$16384$8$1$${salt}$${key.toString("base64")}`)).toBe(true);
  });

  it("reads a password typed with its letters composed another way as the same", async () => {
    const stored = await hashPassword("key й key key");
    expect(await verifyPassword("key й key key", stored)).toBe(true);
  });

  it("throws on a broken row rather than calling it a wrong password", async () => {
    await expect(verifyPassword("password", "plain-text-password")).rejects.toThrow("unknown shape");
    await expect(verifyPassword("password", "bcrypt$1$2$3$4$5")).rejects.toThrow("unknown shape");
  });
});
