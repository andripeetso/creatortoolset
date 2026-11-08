import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../env";
import type { ConnectedAccount, SocialPlatform } from "../../../contracts/connectors";

/**
 * Each account's connected social accounts. One file per user, mode 0600,
 * tokens never leave the server. Read synchronously and cached: Graph calls ask for a token on every request.
 */

export interface StoredAccount extends ConnectedAccount {
  /** The login's token for this account (a Facebook Page's own token, an Instagram account's user token…). */
  token?: string;
  refresh?: string;
  expiresAt?: number;
}

interface UserConnectors {
  accounts: StoredAccount[];
}

const ROOT = path.join(env.dataDir, "connectors");
const cache = new Map<string, UserConnectors>();
const fileOf = (user: string) => path.join(ROOT, `${user.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);

export function readConnectors(user: string): UserConnectors {
  const hit = cache.get(user);
  if (hit) return hit;
  let out: UserConnectors = { accounts: [] };
  try {
    const raw = JSON.parse(readFileSync(fileOf(user), "utf-8")) as UserConnectors;
    if (Array.isArray(raw.accounts)) out = raw;
  } catch {
    /* none yet */
  }
  cache.set(user, out);
  return out;
}

function write(user: string, data: UserConnectors): void {
  mkdirSync(ROOT, { recursive: true });
  const file = fileOf(user);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
  cache.set(user, data);
}

const keyOf = (a: Pick<ConnectedAccount, "platform" | "platformId">) => `${a.platform}:${a.platformId}`;

/** Add or replace accounts (same platform + id), keeping a replaced one's project link. */
export function saveAccounts(user: string, next: Array<Omit<StoredAccount, "key" | "connectedAt"> & Partial<Pick<StoredAccount, "connectedAt">>>): StoredAccount[] {
  const cur = readConnectors(user).accounts;
  const saved: StoredAccount[] = [];
  const accounts = [...cur];
  for (const a of next) {
    const key = keyOf(a);
    const i = accounts.findIndex((x) => x.key === key);
    const old = i >= 0 ? accounts[i] : undefined;
    const row: StoredAccount = { ...old, ...a, key, connectedAt: a.connectedAt ?? old?.connectedAt ?? Date.now(), projectId: a.projectId ?? old?.projectId };
    if (i >= 0) accounts[i] = row;
    else accounts.push(row);
    saved.push(row);
  }
  write(user, { accounts });
  return saved;
}

export function patchAccount(user: string, key: string, patch: Partial<StoredAccount>): StoredAccount | null {
  const accounts = readConnectors(user).accounts.map((a) => (a.key === key ? { ...a, ...patch, key } : a));
  const hit = accounts.find((a) => a.key === key) ?? null;
  if (hit) write(user, { accounts });
  return hit;
}

export function removeAccount(user: string, key: string): boolean {
  const cur = readConnectors(user).accounts;
  const accounts = cur.filter((a) => a.key !== key);
  if (accounts.length === cur.length) return false;
  write(user, { accounts });
  return true;
}

export const findAccount = (user: string, key: string) => readConnectors(user).accounts.find((a) => a.key === key) ?? null;

/** The connected Instagram account with this handle: its Graph login, for the Analyzer's pulls. */
export function instagramLogin(user: string, username: string): { token: string; userId: string } | null {
  const u = username.toLowerCase();
  const a = readConnectors(user).accounts.find((x) => x.platform === "instagram" && x.via === "login" && x.handle.toLowerCase() === u && x.token);
  if (!a?.token || a.loginStatus === "needs_reconnect") return null;
  // an expired token with no refresh is dead: the Analyzer falls back to the install's own login
  if (a.expiresAt && a.expiresAt <= Date.now() && !a.refresh) return null;
  return { token: a.token, userId: a.platformId };
}

/** Public view: no tokens. */
export function publicAccount(a: StoredAccount): ConnectedAccount {
  const { token: _t, refresh: _r, expiresAt, ...rest } = a;
  return { ...rest, ...(expiresAt ? { loginExpiresAt: expiresAt } : {}) };
}

export const newState = () => randomUUID();
export type { SocialPlatform };
