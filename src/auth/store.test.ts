import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";
import { hashPassword } from "./password.js";
import { SESSION_MS, tokenHash } from "./session.js";
import { createAuthService } from "./store.js";

const PASSWORD = "correct horse battery";
const passwordHash = await hashPassword(PASSWORD);
const MINUTE_MS = 60_000;

interface SessionRow {
  tokenHash: string;
  userId: number;
  expiresAt: Date;
}

interface UserRow {
  id: number;
  login: string;
  role: "admin" | "manager";
  passwordHash: string;
  isActive: boolean;
}

// The few calls the service makes, on arrays
function fakeDb(users: UserRow[], sessions: SessionRow[] = []) {
  const db = {
    appUser: {
      findUnique: ({ where }: { where: { login: string } }) =>
        Promise.resolve(users.find((user) => user.login === where.login) ?? null),
    },
    userSession: {
      create: ({ data }: { data: SessionRow }) => {
        sessions.push(data);
        return Promise.resolve(data);
      },
      findUnique: ({ where }: { where: { tokenHash: string } }) => {
        const session = sessions.find((row) => row.tokenHash === where.tokenHash);
        const user = users.find((row) => row.id === session?.userId);
        return Promise.resolve(session && user ? { expiresAt: session.expiresAt, user } : null);
      },
      deleteMany: ({ where }: { where: { tokenHash?: string; userId?: number; expiresAt?: { lte: Date } } }) => {
        const isGone = (row: SessionRow) => (where.tokenHash === undefined || row.tokenHash === where.tokenHash)
          && (where.userId === undefined || row.userId === where.userId)
          && (where.expiresAt === undefined || row.expiresAt <= where.expiresAt.lte);
        const left = sessions.filter((row) => !isGone(row));
        const count = sessions.length - left.length;
        sessions.splice(0, sessions.length, ...left);
        return Promise.resolve({ count });
      },
    },
  };
  return db as unknown as PrismaClient;
}

const user: UserRow = { id: 1, login: "tester", role: "admin", passwordHash, isActive: true };

describe("signIn", () => {
  it("opens a session for the right password, keeping only the token's hash", async () => {
    const sessions: SessionRow[] = [];
    const signedIn = await createAuthService(fakeDb([user], sessions)).signIn("tester", PASSWORD);
    expect(signedIn?.user).toEqual({ id: 1, login: "tester", role: "admin" });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokenHash).toBe(tokenHash(signedIn?.token ?? ""));
    expect(JSON.stringify(sessions)).not.toContain(signedIn?.token);
    expect(sessions[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_MS - MINUTE_MS);
  });

  it.each([
    ["a wrong password", "tester", "wrong password here", [user]],
    ["a login that is not there", "nobody", PASSWORD, [user]],
    ["a disabled user, with the right password", "tester", PASSWORD, [{ ...user, isActive: false }]],
  ])("opens nothing for %s", async (_title, login, password, users) => {
    const sessions: SessionRow[] = [];
    expect(await createAuthService(fakeDb(users, sessions)).signIn(login, password)).toBeNull();
    expect(sessions).toEqual([]);
  });

  it("removes the user's expired sessions and keeps the rest", async () => {
    const past = new Date(Date.now() - MINUTE_MS);
    const future = new Date(Date.now() + MINUTE_MS);
    const sessions = [
      { tokenHash: "expired", userId: 1, expiresAt: past },
      { tokenHash: "live", userId: 1, expiresAt: future },
      { tokenHash: "another user's", userId: 2, expiresAt: past },
    ];
    await createAuthService(fakeDb([user], sessions)).signIn("tester", PASSWORD);
    expect(sessions.map((row) => row.tokenHash)).toEqual(expect.arrayContaining(["live", "another user's"]));
    expect(sessions.map((row) => row.tokenHash)).not.toContain("expired");
  });
});

describe("userOfSession", () => {
  const future = new Date(Date.now() + MINUTE_MS);

  it("finds the user of a live session with their role, without the password's hash", async () => {
    const service = createAuthService(fakeDb([user], [{ tokenHash: tokenHash("t1"), userId: 1, expiresAt: future }]));
    expect(await service.userOfSession("t1")).toStrictEqual({ id: 1, login: "tester", role: "admin" });
  });

  it("knows no token that is not there", async () => {
    expect(await createAuthService(fakeDb([user])).userOfSession("t1")).toBeNull();
  });

  it("ends at the session's time", async () => {
    const past = new Date(Date.now() - 1);
    const service = createAuthService(fakeDb([user], [{ tokenHash: tokenHash("t1"), userId: 1, expiresAt: past }]));
    expect(await service.userOfSession("t1")).toBeNull();
  });

  it("does not let a disabled user in on a session opened earlier", async () => {
    const db = fakeDb([{ ...user, isActive: false }], [{ tokenHash: tokenHash("t1"), userId: 1, expiresAt: future }]);
    expect(await createAuthService(db).userOfSession("t1")).toBeNull();
  });
});

describe("signOut", () => {
  it("deletes that session only", async () => {
    const future = new Date(Date.now() + MINUTE_MS);
    const sessions = [
      { tokenHash: tokenHash("t1"), userId: 1, expiresAt: future },
      { tokenHash: tokenHash("t2"), userId: 1, expiresAt: future },
    ];
    await createAuthService(fakeDb([user], sessions)).signOut("t1");
    expect(sessions.map((row) => row.tokenHash)).toEqual([tokenHash("t2")]);
  });
});
