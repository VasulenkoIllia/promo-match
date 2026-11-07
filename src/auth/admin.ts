// The users of the «Користувачі» screen and the pages of its one-time links (docs/integrations.md, «Логін»). The admin's
// calls come through the scope of src/app.ts that checks the role; the links' through the public routes of
// src/auth/admin-routes.ts. Kept to the login, the role, the password's hash and the links' hashes: no name or email.
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { LinkNotUsable, LoginTaken, OwnAccountChange, UserNotFound } from "./errors.js";
import { ADMIN_ROLE, isLinkUsable, type LinkKind, newLink, type Role } from "./invite.js";
import { hashPassword } from "./password.js";
import { tokenHash } from "./session.js";

// The list is read whole, with no pages: a closed test has a few users. Past this bound it says it is not complete.
const MAX_LISTED_USERS = 500;
const NOT_USABLE = "this link is used, past its end or not valid";

export interface UserEntry {
  id: number;
  login: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
}

export interface UserList {
  users: UserEntry[];
  isComplete: boolean;
}

export interface CreatedLink {
  kind: LinkKind;
  // To the admin's screen only: the database keeps its hash
  token: string;
  expiresAt: Date;
}

export interface AcceptedLink {
  userId: number;
  login: string;
}

export interface UsersService {
  list(): Promise<UserList>;
  createInvite(adminId: number, role: Role): Promise<CreatedLink>;
  // Ends the user's earlier reset links that are not used
  createReset(adminId: number, userId: number): Promise<CreatedLink & { login: string }>;
  // Disabling ends the user's sessions and reset links
  setActive(adminId: number, userId: number, isActive: boolean): Promise<void>;
  acceptInvite(token: string, login: string, password: string): Promise<AcceptedLink>;
  // Ends all the user's sessions
  acceptReset(token: string, password: string): Promise<AcceptedLink>;
}

const LINK_SELECT = {
  id: true, kind: true, role: true, userId: true, usedAt: true, expiresAt: true,
  createdBy: { select: { isActive: true, role: true } },
} as const;

// isLinkUsable in SQL, for the update that takes the link: the row stays locked until the transaction ends, and a
// second use waiting on it then finds used_at set and takes nothing
function takenLinkWhere(id: number, kind: LinkKind, now: Date): Prisma.UserInviteWhereInput {
  return { id, kind, usedAt: null, expiresAt: { gt: now }, createdBy: { isActive: true, role: ADMIN_ROLE } };
}

// A reset link made before would set a password again, of a user disabled since or after a newer link
function endPendingResets(client: Prisma.TransactionClient, userId: number, now: Date) {
  return client.userInvite.updateMany({
    where: { userId, kind: "reset", usedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now },
  });
}

export function createUsersService(db: PrismaClient): UsersService {
  // Read before the password is hashed, so a link that is not usable costs no hash
  async function usableLink(token: string, kind: LinkKind) {
    const link = await db.userInvite.findUnique({ where: { tokenHash: tokenHash(token) }, select: LINK_SELECT });
    if (!link || !isLinkUsable(link, kind, new Date())) throw new LinkNotUsable(NOT_USABLE);
    return link;
  }

  async function takeLink(tx: Prisma.TransactionClient, id: number, kind: LinkKind) {
    const now = new Date();
    const { count } = await tx.userInvite.updateMany({ where: takenLinkWhere(id, kind, now), data: { usedAt: now } });
    if (!count) throw new LinkNotUsable(NOT_USABLE);
  }

  return {
    async list() {
      const users = await db.appUser.findMany({
        select: { id: true, login: true, role: true, isActive: true, createdAt: true },
        orderBy: { login: "asc" }, take: MAX_LISTED_USERS + 1,
      });
      return { users: users.slice(0, MAX_LISTED_USERS), isComplete: users.length <= MAX_LISTED_USERS };
    },

    async createInvite(adminId, role) {
      const link = newLink(new Date());
      await db.userInvite.create({
        data: { tokenHash: link.tokenHash, kind: "invite", role, createdById: adminId, expiresAt: link.expiresAt },
      });
      return { kind: "invite", token: link.token, expiresAt: link.expiresAt };
    },

    async createReset(adminId, userId) {
      const now = new Date();
      const link = newLink(now);
      return db.$transaction(async (tx) => {
        const user = await tx.appUser.findUnique({ where: { id: userId }, select: { login: true } });
        if (!user) throw new UserNotFound("no such user");
        await endPendingResets(tx, userId, now);
        await tx.userInvite.create({
          data: { tokenHash: link.tokenHash, kind: "reset", createdById: adminId, userId, expiresAt: link.expiresAt },
        });
        return { kind: "reset", token: link.token, expiresAt: link.expiresAt, login: user.login };
      });
    },

    async setActive(adminId, userId, isActive) {
      if (isActive) {
        const { count } = await db.appUser.updateMany({ where: { id: userId }, data: { isActive } });
        if (!count) throw new UserNotFound("no such user");
        return;
      }
      if (userId === adminId) throw new OwnAccountChange("an admin cannot disable their own account");
      // All at once, or a session or a link could outlive the disabling
      const [{ count }] = await db.$transaction([
        db.appUser.updateMany({ where: { id: userId }, data: { isActive } }),
        db.userSession.deleteMany({ where: { userId } }),
        endPendingResets(db, userId, new Date()),
      ]);
      if (!count) throw new UserNotFound("no such user");
    },

    async acceptInvite(token, login, password) {
      const link = await usableLink(token, "invite");
      const { role } = link;
      if (!role) throw new Error(`invite ${link.id} has no role, which its CHECK forbids`);
      const passwordHash = await hashPassword(password);
      return db.$transaction(async (tx) => {
        await takeLink(tx, link.id, "invite");
        // ON CONFLICT DO NOTHING: a taken login ends the transaction by this throw, not by a failed statement, and the
        // link stays unused for another try
        const [user] = await tx.appUser.createManyAndReturn({
          data: { login, passwordHash, role }, skipDuplicates: true, select: { id: true },
        });
        if (!user) throw new LoginTaken("this login is taken");
        await tx.userInvite.update({ where: { id: link.id }, data: { userId: user.id } });
        return { userId: user.id, login };
      });
    },

    async acceptReset(token, password) {
      const link = await usableLink(token, "reset");
      const { userId } = link;
      if (userId === null) throw new Error(`reset ${link.id} has no user, which its CHECK forbids`);
      const passwordHash = await hashPassword(password);
      return db.$transaction(async (tx) => {
        await takeLink(tx, link.id, "reset");
        const user = await tx.appUser.update({ where: { id: userId }, data: { passwordHash }, select: { login: true } });
        await tx.userSession.deleteMany({ where: { userId } });
        return { userId, login: user.login };
      });
    },
  };
}
