// Users and sessions in the database (docs/integrations.md, «Логін»). Kept to the login, the password's hash and the
// session's end: no name, email or address.
import type { PrismaClient } from "../generated/prisma/client.js";
import type { Role } from "./invite.js";
import { hashPassword, verifyPassword } from "./password.js";
import { newSessionToken, SESSION_MS, tokenHash } from "./session.js";

export interface SessionUser {
  id: number;
  login: string;
  role: Role;
}

export interface SignedIn {
  user: SessionUser;
  // Goes into the cookie and nowhere else: the database keeps its hash
  token: string;
}

export interface AuthService {
  // Null: a wrong login or password, or a disabled user; neither the answer nor its time tells which
  signIn(login: string, password: string): Promise<SignedIn | null>;
  userOfSession(token: string): Promise<SessionUser | null>;
  signOut(token: string): Promise<void>;
}

export function createAuthService(db: PrismaClient): AuthService {
  // A login that is not there costs one hash too, or the time of the answer would tell which logins exist
  const absentUserHash = hashPassword(newSessionToken());

  return {
    async signIn(login, password) {
      const user = await db.appUser.findUnique({
        where: { login }, select: { id: true, login: true, role: true, passwordHash: true, isActive: true },
      });
      const isMatch = await verifyPassword(password, user?.passwordHash ?? await absentUserHash);
      if (!user?.isActive || !isMatch) return null;
      const token = newSessionToken();
      await db.userSession.create({
        data: { userId: user.id, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + SESSION_MS) },
      });
      // Nothing else removes an expired row; there are a few per user at most
      await db.userSession.deleteMany({ where: { userId: user.id, expiresAt: { lte: new Date() } } });
      return { user: { id: user.id, login: user.login, role: user.role }, token };
    },

    async userOfSession(token) {
      const session = await db.userSession.findUnique({
        where: { tokenHash: tokenHash(token) },
        select: { expiresAt: true, user: { select: { id: true, login: true, role: true, isActive: true } } },
      });
      if (!session?.user.isActive || session.expiresAt <= new Date()) return null;
      return { id: session.user.id, login: session.user.login, role: session.user.role };
    },

    async signOut(token) {
      await db.userSession.deleteMany({ where: { tokenHash: tokenHash(token) } });
    },
  };
}
