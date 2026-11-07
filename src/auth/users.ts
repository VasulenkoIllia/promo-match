// WORKER=users: whoever runs the server makes and manages the users, there is no sign-up (docs/deployment.md,
// «Користувачі»). The first admin comes from here; after them, admins invite on the «Користувачі» screen.
//   npm run users -- add <login> [--role admin|manager] | password <login> | disable <login> | enable <login> | list
// The password is read hidden from the terminal, or as a line from a pipe; never an argument, which the shell's history
// and `ps` would keep. A new password and disabling end the user's sessions. add makes a manager unless told otherwise.
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { ConfigError } from "../config.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { UserRole } from "../generated/prisma/enums.js";
import { checkDatabase } from "../import/run.js";
import type { Role } from "./invite.js";
import { hashPassword } from "./password.js";
import { loginProblem, passwordProblem, tidiedLogin } from "./request.js";

const USAGE = "usage: add <login> [--role admin|manager] | password <login> | disable <login> | enable <login> | list";

type Log = (line: string) => void;

// readline with its output thrown away: in a terminal the typed characters are not echoed
function readHiddenLine(prompt: string): Promise<string> {
  const reader = createInterface({
    input: process.stdin, output: new Writable({ write: (_chunk, _encoding, done) => done() }), terminal: process.stdin.isTTY,
  });
  process.stderr.write(prompt);
  return new Promise<string>((resolve, reject) => {
    reader.once("line", resolve);
    reader.once("close", () => reject(new ConfigError("no password: stdin closed")));
  }).finally(() => {
    reader.close();
    process.stderr.write("\n");
  });
}

async function readPassword(): Promise<string> {
  const password = await readHiddenLine("Password: ");
  const problem = passwordProblem(password);
  if (problem) throw new ConfigError(problem);
  // A pipe has no second line and nobody to mistype
  if (process.stdin.isTTY && await readHiddenLine("Again: ") !== password) {
    throw new ConfigError("the two passwords differ");
  }
  return password;
}

// Both writes at once, or a session could outlive a new password
async function updateAndEndSessions(db: PrismaClient, login: string, data: { passwordHash: string } | { isActive: false }) {
  const [{ count }] = await db.$transaction([
    db.appUser.updateMany({ where: { login }, data }),
    db.userSession.deleteMany({ where: { user: { login } } }),
  ]);
  if (!count) throw new ConfigError(`no user "${login}"`);
}

async function addUser(db: PrismaClient, login: string, log: Log, role: Role): Promise<void> {
  const problem = loginProblem(login);
  if (problem) throw new ConfigError(problem);
  const passwordHash = await hashPassword(await readPassword());
  const { count } = await db.appUser.createMany({ data: { login, passwordHash, role }, skipDuplicates: true });
  if (!count) throw new ConfigError(`user "${login}" exists`);
  log(`added ${login}, ${role}`);
}

async function setPassword(db: PrismaClient, login: string, log: Log): Promise<void> {
  await updateAndEndSessions(db, login, { passwordHash: await hashPassword(await readPassword()) });
  log(`new password for ${login}, its sessions ended`);
}

async function disableUser(db: PrismaClient, login: string, log: Log): Promise<void> {
  await updateAndEndSessions(db, login, { isActive: false });
  log(`disabled ${login}, its sessions ended`);
}

async function enableUser(db: PrismaClient, login: string, log: Log): Promise<void> {
  const { count } = await db.appUser.updateMany({ where: { login }, data: { isActive: true } });
  if (!count) throw new ConfigError(`no user "${login}"`);
  log(`enabled ${login}`);
}

async function listUsers(db: PrismaClient, log: Log): Promise<void> {
  const users = await db.appUser.findMany({
    select: { login: true, role: true, isActive: true, createdAt: true }, orderBy: { login: "asc" },
  });
  for (const user of users) {
    log(`${user.login} ${user.role} ${user.isActive ? "active" : "disabled"} since ${user.createdAt.toISOString()}`);
  }
  log(`${users.length} users`);
}

const ACTIONS: Record<string, (db: PrismaClient, login: string, log: Log) => Promise<void>> = {
  password: setPassword, disable: disableUser, enable: enableUser,
};

// --role of add only; a manager when it is left out
function roleOf(value: string | undefined): Role {
  if (value === undefined) return UserRole.manager;
  if (!Object.hasOwn(UserRole, value)) throw new ConfigError(`--role must be one of ${Object.values(UserRole).join(", ")}`);
  return value as Role;
}

export async function runUsers(db: PrismaClient, argv: string[], log: Log): Promise<void> {
  const { positionals: [command, login, ...rest], values } = parseArgs({
    args: argv, allowPositionals: true, strict: true, options: { role: { type: "string" } },
  });
  if (command === "list" && !login && values.role === undefined) {
    await listUsers(db, log);
    return;
  }
  if (command === "add" && login && !rest.length) {
    const role = roleOf(values.role);
    await checkDatabase(db, log);
    await addUser(db, tidiedLogin(login), log, role);
    return;
  }
  // Own keys only: an inherited name such as "constructor" is no command
  const action = command !== undefined && Object.hasOwn(ACTIONS, command) ? ACTIONS[command] : undefined;
  if (!action || !login || rest.length || values.role !== undefined) throw new ConfigError(USAGE);
  await checkDatabase(db, log);
  await action(db, tidiedLogin(login), log);
}
