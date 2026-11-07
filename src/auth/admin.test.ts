import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createUsersService } from "./admin.js";
import { LinkNotUsable, LoginTaken, OwnAccountChange } from "./errors.js";
import type { LinkKind, Role } from "./invite.js";
import { verifyPassword } from "./password.js";
import { tokenHash } from "./session.js";

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "another horse battery";

interface UserRow {
  id: number;
  login: string;
  role: Role;
  passwordHash: string;
  isActive: boolean;
}

interface InviteRow {
  id: number;
  tokenHash: string;
  kind: LinkKind;
  role: Role | null;
  createdById: number;
  userId: number | null;
  expiresAt: Date;
  usedAt: Date | null;
}

interface SessionRow {
  userId: number;
  tokenHash: string;
}

interface State {
  users: UserRow[];
  invites: InviteRow[];
  sessions: SessionRow[];
}

interface InviteWhere {
  id?: number;
  kind?: LinkKind;
  userId?: number;
  usedAt?: null;
  expiresAt?: { gt: Date };
  createdBy?: { isActive: boolean; role: Role };
}

// The calls the service makes, on arrays. A transaction given a function puts the arrays back when it throws, as
// Postgres rolls back.
function fakeDb(state: State) {
  const userOf = (id: number | null) => state.users.find((user) => user.id === id);
  const isMatch = (row: InviteRow, where: InviteWhere) => (where.id === undefined || row.id === where.id)
    && (where.kind === undefined || row.kind === where.kind) && (where.userId === undefined || row.userId === where.userId)
    && (!("usedAt" in where) || row.usedAt === null) && (where.expiresAt === undefined || row.expiresAt > where.expiresAt.gt)
    && (where.createdBy === undefined || (userOf(row.createdById)?.isActive === where.createdBy.isActive
      && userOf(row.createdById)?.role === where.createdBy.role));
  const db = {
    userInvite: {
      findUnique: ({ where }: { where: { tokenHash: string } }) => {
        const row = state.invites.find((invite) => invite.tokenHash === where.tokenHash);
        const creator = userOf(row?.createdById ?? null);
        return Promise.resolve(row && creator ? { ...row, createdBy: { isActive: creator.isActive, role: creator.role } } : null);
      },
      create: ({ data }: { data: Omit<InviteRow, "id" | "usedAt" | "role" | "userId"> & Partial<InviteRow> }) => {
        state.invites.push({ id: state.invites.length + 1, usedAt: null, role: null, userId: null, ...data });
        return Promise.resolve();
      },
      updateMany: ({ where, data }: { where: InviteWhere; data: Partial<InviteRow> }) => {
        const rows = state.invites.filter((row) => isMatch(row, where));
        for (const row of rows) Object.assign(row, data);
        return Promise.resolve({ count: rows.length });
      },
      update: ({ where, data }: { where: { id: number }; data: Partial<InviteRow> }) => {
        Object.assign(state.invites.find((row) => row.id === where.id) ?? {}, data);
        return Promise.resolve();
      },
    },
    appUser: {
      findUnique: ({ where }: { where: { id: number } }) => Promise.resolve(userOf(where.id) ?? null),
      createManyAndReturn: ({ data }: { data: Omit<UserRow, "id" | "isActive"> }) => {
        if (state.users.some((user) => user.login === data.login)) return Promise.resolve([]);
        const id = state.users.length + 1;
        state.users.push({ id, isActive: true, ...data });
        return Promise.resolve([{ id }]);
      },
      update: ({ where, data }: { where: { id: number }; data: Partial<UserRow> }) => {
        const user = userOf(where.id);
        if (!user) return Promise.reject(new Error("no such row"));
        Object.assign(user, data);
        return Promise.resolve({ login: user.login });
      },
      updateMany: ({ where, data }: { where: { id: number }; data: Partial<UserRow> }) => {
        const user = userOf(where.id);
        if (user) Object.assign(user, data);
        return Promise.resolve({ count: user ? 1 : 0 });
      },
    },
    userSession: {
      deleteMany: ({ where }: { where: { userId: number } }) => {
        const left = state.sessions.filter((row) => row.userId !== where.userId);
        const count = state.sessions.length - left.length;
        state.sessions.splice(0, state.sessions.length, ...left);
        return Promise.resolve({ count });
      },
    },
    $transaction: async (work: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) => {
      if (Array.isArray(work)) return Promise.all(work);
      const saved = structuredClone(state);
      try {
        return await work(db);
      } catch (error) {
        state.users.splice(0, state.users.length, ...saved.users);
        state.invites.splice(0, state.invites.length, ...saved.invites);
        state.sessions.splice(0, state.sessions.length, ...saved.sessions);
        throw error;
      }
    },
  };
  return db as unknown as PrismaClient;
}

function stateWithAdmin(): State {
  return {
    users: [
      { id: 1, login: "boss", role: "admin", passwordHash: "scrypt$1$1$1$a$b", isActive: true },
      { id: 2, login: "worker", role: "manager", passwordHash: "scrypt$1$1$1$a$b", isActive: true },
    ],
    invites: [],
    sessions: [{ userId: 2, tokenHash: "worker's" }, { userId: 1, tokenHash: "boss's" }],
  };
}

describe("an invite", () => {
  it("keeps the token's hash only, and makes one user of the invite's role, once", async () => {
    const state = stateWithAdmin();
    const service = createUsersService(fakeDb(state));
    const { token } = await service.createInvite(1, "admin");
    expect(state.invites[0]?.tokenHash).toBe(tokenHash(token));
    expect(JSON.stringify(state.invites)).not.toContain(token);

    const made = await service.acceptInvite(token, "new.one", PASSWORD);
    const user = state.users.find((row) => row.login === "new.one");
    expect(made).toEqual({ userId: user?.id, login: "new.one" });
    expect(user?.role).toBe("admin");
    expect(user?.passwordHash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, user?.passwordHash ?? "")).toBe(true);
    expect(state.invites[0]?.userId).toBe(user?.id);
    expect(state.invites[0]?.usedAt).toBeInstanceOf(Date);

    await expect(service.acceptInvite(token, "second.one", PASSWORD)).rejects.toThrow(LinkNotUsable);
    expect(state.users.map((row) => row.login)).not.toContain("second.one");
  });

  it("stays unused after a login taken, for another try", async () => {
    const state = stateWithAdmin();
    const service = createUsersService(fakeDb(state));
    const { token } = await service.createInvite(1, "manager");
    await expect(service.acceptInvite(token, "worker", PASSWORD)).rejects.toThrow(LoginTaken);
    expect(state.invites[0]?.usedAt).toBeNull();
    expect(await service.acceptInvite(token, "new.one", PASSWORD)).toMatchObject({ login: "new.one" });
  });

  it.each([
    ["past its end", (state: State) => Object.assign(state.invites[0] ?? {}, { expiresAt: new Date(Date.now() - 1) })],
    ["made by an admin disabled since", (state: State) => Object.assign(state.users[0] ?? {}, { isActive: false })],
  ])("is not usable %s", async (_title, change) => {
    const state = stateWithAdmin();
    const service = createUsersService(fakeDb(state));
    const { token } = await service.createInvite(1, "manager");
    change(state);
    await expect(service.acceptInvite(token, "new.one", PASSWORD)).rejects.toThrow(LinkNotUsable);
    expect(state.users).toHaveLength(2);
  });

  it("does not set a password: its token on the reset page is not usable", async () => {
    const service = createUsersService(fakeDb(stateWithAdmin()));
    const { token } = await service.createInvite(1, "manager");
    await expect(service.acceptReset(token, NEW_PASSWORD)).rejects.toThrow(LinkNotUsable);
  });
});

describe("a reset", () => {
  it("sets the new password and ends all the user's sessions, not another's, once", async () => {
    const state = stateWithAdmin();
    const service = createUsersService(fakeDb(state));
    const { token, login } = await service.createReset(1, 2);
    expect(login).toBe("worker");
    expect(await service.acceptReset(token, NEW_PASSWORD)).toEqual({ userId: 2, login: "worker" });
    expect(await verifyPassword(NEW_PASSWORD, state.users[1]?.passwordHash ?? "")).toBe(true);
    expect(state.sessions).toEqual([{ userId: 1, tokenHash: "boss's" }]);
    await expect(service.acceptReset(token, PASSWORD)).rejects.toThrow(LinkNotUsable);
  });

  it("ends the user's earlier reset link that is not used", async () => {
    const service = createUsersService(fakeDb(stateWithAdmin()));
    const first = await service.createReset(1, 2);
    const second = await service.createReset(1, 2);
    await expect(service.acceptReset(first.token, NEW_PASSWORD)).rejects.toThrow(LinkNotUsable);
    expect(await service.acceptReset(second.token, NEW_PASSWORD)).toMatchObject({ login: "worker" });
  });
});

describe("disabling", () => {
  it("is refused to the admin's own account", async () => {
    const state = stateWithAdmin();
    await expect(createUsersService(fakeDb(state)).setActive(1, 1, false)).rejects.toThrow(OwnAccountChange);
    expect(state.users[0]?.isActive).toBe(true);
  });

  it("ends the user's sessions and reset links", async () => {
    const state = stateWithAdmin();
    const service = createUsersService(fakeDb(state));
    const { token } = await service.createReset(1, 2);
    await service.setActive(1, 2, false);
    expect(state.users[1]?.isActive).toBe(false);
    expect(state.sessions.map((row) => row.userId)).toEqual([1]);
    await service.setActive(1, 2, true);
    await expect(service.acceptReset(token, NEW_PASSWORD)).rejects.toThrow(LinkNotUsable);
  });
});

describe("the list", () => {
  it("has the role and not the password's hash", async () => {
    const state = stateWithAdmin();
    state.users[0] = { ...(state.users[0] as UserRow), passwordHash: "secret-hash" };
    const db = fakeDb(state);
    Object.assign(db.appUser, {
      findMany: ({ select }: { select: Record<string, boolean> }) =>
        Promise.resolve(state.users.map((user) => Object.fromEntries(Object.keys(select).map((key) => [key, user[key as keyof UserRow]])))),
    });
    const { users, isComplete } = await createUsersService(db).list();
    expect(isComplete).toBe(true);
    expect(users[0]).toMatchObject({ login: "boss", role: "admin", isActive: true });
    expect(JSON.stringify(users)).not.toContain("secret-hash");
  });
});
