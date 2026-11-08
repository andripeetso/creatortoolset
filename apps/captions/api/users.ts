import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./lib/env";
import { TOOLS, isTool, type Tool } from "../contracts/tools";

export { isTool, type Tool };

/**
 * File-based user accounts, matching the app's file-based project
 * storage: $DATA_DIR/users.json. Scrypt-hashed passwords, a role that
 * decides every permission (see applyRole), and lightweight usage
 * counters.
 *
 * Bootstrapping: when APP_SECRET is set and no admin exists, an
 * "admin" account (ADMIN_USERNAME to override) is created with
 * APP_SECRET as its password — existing single-password deployments
 * keep working, the password just gains a username.
 */

export interface UserUsage {
  logins: number;
  projectsCreated: number;
  cloudRuns: number;
  cloudSeconds: number;
  aiRuns: number; // AI caption-cadence passes
  renders: number;
  enhanceRuns: number; // audio enhancement jobs
  lastActiveAt: number; // epoch ms, 0 = never
}

export interface UserRecord {
  username: string;
  salt: string;
  hash: string;
  role: Role;
  cloud: boolean; // cloud transcription and AI in Caption Studio (every account)
  /** Apps switched off for this account (none unless users.json says so). */
  off: Tool[];
  /** sha256 of the Review key: a script or AI reads Review and resolves comments as this user. */
  apiKeyHash?: string;
  /** sha256 of the Full key: a script or AI does what this account does on the site, except Admin, AI settings and paired Macs (boot.ts). */
  fullKeyHash?: string;
  /** What the Settings page shows of each key it can't show again: when it was made, its last 4 characters, when it was last used. */
  keyInfo?: Partial<Record<KeyLevel, { at: number; last4: string; usedAt?: number }>>;
  /** What the app calls the person (Settings → Account); unset = the username. */
  displayName?: string;
  createdAt: number;
  usage: UserUsage;
}

/**
 * Apps: every one is on for an account unless switched off (contracts/tools.ts). The role only says who is an admin.
 */

export type Role = "admin" | "team" | "user";
export const isRole = (r: unknown): r is Role =>
  r === "admin" || r === "team" || r === "user";

export function applyRole(user: UserRecord, role: Role): UserRecord {
  user.role = role;
  user.cloud = true;
  return user;
}

/** What request handlers see — never includes credentials. */
export interface SessionUser {
  username: string;
  /** The display name (accounts only). */
  name?: string;
  role: Role | "visitor";
  cloud: boolean;
  off: Tool[];
}

export const mayUse = (user: SessionUser, tool: Tool): boolean =>
  user.role === "admin" || !user.off.includes(tool);

/** Stand-in identity when auth is disabled (no APP_SECRET, local use). */
export const LOCAL_USER: SessionUser = {
  username: "local",
  role: "admin",
  cloud: true,
  off: [],
};

/**
 * Someone with no session on a public share link (Review, Workshop, Media Library, Video Notes): not an account,
 * every app off, so the share routes are all it reaches (boot.ts).
 */
export const VISITOR: SessionUser = {
  username: "visitor",
  role: "visitor",
  cloud: false,
  off: [...TOOLS],
};

export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,23}$/;

const USERS_FILE = path.join(env.dataDir, "users.json");

const emptyUsage = (): UserUsage => ({
  logins: 0,
  projectsCreated: 0,
  cloudRuns: 0,
  cloudSeconds: 0,
  aiRuns: 0,
  renders: 0,
  enhanceRuns: 0,
  lastActiveAt: 0,
});

function load(): UserRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(USERS_FILE, "utf-8"));
    if (!Array.isArray(parsed.users)) return [];
    return parsed.users.map((u: UserRecord & { enhance?: boolean }) => {
      const user = { ...u, off: (u.off ?? []).filter(isTool), usage: { ...emptyUsage(), ...(u.usage ?? {}) } };
      delete user.enhance; // the flag the app switches replaced
      return applyRole(user, u.role);
    });
  } catch {
    return [];
  }
}

const users: UserRecord[] = load();

// serialize writes so concurrent bumps can't interleave the tmp file
let writeChain: Promise<void> = Promise.resolve();

function persist(): void {
  const snapshot = JSON.stringify({ users }, null, 2);
  writeChain = writeChain.then(async () => {
    try {
      await mkdir(env.dataDir, { recursive: true });
      const tmp = USERS_FILE + ".tmp";
      await writeFile(tmp, snapshot);
      await rename(tmp, USERS_FILE);
    } catch (e) {
      console.error("[users] failed to persist users.json:", e);
    }
  });
}

const hashPassword = (password: string, salt: string) =>
  scryptSync(password, salt, 32).toString("hex");

export function findUser(username: string): UserRecord | null {
  const name = username.toLowerCase();
  return users.find((u) => u.username === name) ?? null;
}

/** Settings → Account: what the app calls the person. Empty = the username again. */
export function setDisplayName(user: UserRecord, name: string): void {
  // eslint-disable-next-line no-control-regex
  const n = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);
  if (n) user.displayName = n;
  else delete user.displayName;
  persist();
}

export function verifyPassword(user: UserRecord, password: string): boolean {
  const attempt = Buffer.from(hashPassword(password, user.salt), "hex");
  const actual = Buffer.from(user.hash, "hex");
  return attempt.length === actual.length && timingSafeEqual(attempt, actual);
}

export function createUser(
  username: string,
  password: string,
  opts: { role?: Role; bootstrap?: boolean } = {},
): UserRecord {
  const name = username.toLowerCase();
  if (!USERNAME_RE.test(name)) throw new Error("Invalid username");
  // "workspace" names the admins' AI providers and their devices (contracts/providers.ts); "visitor" the share-link visitor
  if (name === "workspace" || name === VISITOR.username) throw new Error(`"${name}" is reserved`);
  if (findUser(name)) throw new Error("Username already taken");
  // bootstrap must never lock the deployment out over a short APP_SECRET
  if (!opts.bootstrap && password.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }
  const salt = randomBytes(16).toString("hex");
  const user = applyRole(
    {
      username: name,
      salt,
      hash: hashPassword(password, salt),
      role: "user",
      cloud: false,
      off: [],
      createdAt: Date.now(),
      usage: emptyUsage(),
    },
    opts.role ?? "user",
  );
  users.push(user);
  persist();
  return user;
}

export function setPassword(user: UserRecord, password: string): void {
  if (password.length < 6)
    throw new Error("Password must be at least 6 characters");
  user.salt = randomBytes(16).toString("hex");
  user.hash = hashPassword(password, user.salt); // also rotates auth cookies
  persist();
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** AI access keys come in two levels: "review" (Review) and "full" (headless: everything the account does). */
export type KeyLevel = "review" | "full";

/** A fresh key of that level, shown once and stored hashed; the old one of the same level stops working. */
export function newApiKey(user: UserRecord, level: KeyLevel = "review"): string {
  const key = `ctk_${randomBytes(24).toString("hex")}`;
  if (level === "full") user.fullKeyHash = sha256(key);
  else user.apiKeyHash = sha256(key);
  user.keyInfo = { ...user.keyInfo, [level]: { at: Date.now(), last4: key.slice(-4) } };
  persist();
  return key;
}

/** Turns a key off; making a new one is the only way back. */
export function dropApiKey(user: UserRecord, level: KeyLevel): void {
  if (level === "full") delete user.fullKeyHash;
  else delete user.apiKeyHash;
  if (user.keyInfo) delete user.keyInfo[level];
  persist();
}

/** The keys an account has: on, and what is known about each (keys made before 2026-11-06 know nothing). */
export function apiKeysOf(user: UserRecord): Record<KeyLevel, { at?: number; last4?: string; usedAt?: number } | null> {
  const of = (level: KeyLevel, hash?: string) => (hash ? { ...user.keyInfo?.[level] } : null);
  return { review: of("review", user.apiKeyHash), full: of("full", user.fullKeyHash) };
}

export function userForApiKey(key: string, level: KeyLevel = "review"): UserRecord | null {
  const hash = sha256(key);
  const user = users.find((u) => (level === "full" ? u.fullKeyHash : u.apiKeyHash) === hash) ?? null;
  // last used, saved at most once a minute
  const info = user?.keyInfo?.[level];
  if (user && Date.now() - (info?.usedAt ?? 0) > ACTIVE_WRITE_INTERVAL) {
    user.keyInfo = { ...user.keyInfo, [level]: { at: info?.at ?? 0, last4: info?.last4 ?? "", usedAt: Date.now() } };
    persist();
  }
  return user;
}

export function adminCount(): number {
  return users.filter((u) => u.role === "admin").length;
}

export function listUsers(): UserRecord[] {
  return users;
}

export function bumpUsage(
  username: string,
  patch: Partial<Omit<UserUsage, "lastActiveAt">>,
): void {
  const user = findUser(username);
  if (!user) return; // LOCAL_USER or a just-deleted account
  for (const [k, v] of Object.entries(patch)) {
    const key = k as keyof UserUsage;
    user.usage[key] = (user.usage[key] || 0) + (v || 0);
  }
  user.usage.lastActiveAt = Date.now();
  persist();
}

// lastActiveAt is touched on every authed request — only hit the disk
// when the stored value is more than a minute stale
const ACTIVE_WRITE_INTERVAL = 60_000;

export function touchActive(username: string): void {
  const user = findUser(username);
  if (!user) return;
  const now = Date.now();
  if (now - user.usage.lastActiveAt < ACTIVE_WRITE_INTERVAL) return;
  user.usage.lastActiveAt = now;
  persist();
}

/* bootstrap: guarantee an admin exists whenever auth is active */
if (env.appSecret && adminCount() === 0) {
  const name = USERNAME_RE.test(env.adminUsername)
    ? env.adminUsername
    : "admin";
  const existing = findUser(name);
  if (existing) {
    applyRole(existing, "admin");
    persist();
    console.log(`[users] promoted "${name}" to admin`);
  } else {
    createUser(name, env.appSecret, { role: "admin", bootstrap: true });
    console.log(
      `[users] created admin account "${name}" (password = APP_SECRET)`,
    );
  }
}
