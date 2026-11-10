import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../env";
import type { ConnectedAccount, SocialPlatform } from "../../../contracts/connectors";

/**
 * Each account's connected social accounts. One file per user, mode 0600,
 * tokens never leave the server. Read synchronously and cached: Graph calls ask for a token on every request.
 */

/** One post's counts as a pull saw them on one day. Platforms give running totals, so a day's gain is the difference from the day before. */
export interface VideoSnapshot {
  day: string;
  id: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
}

/** One account-level day as a pull saw it (Instagram's reach and new follows). `id` is the account's key, so one row per account and day. */
export interface AccountDay {
  day: string;
  id: string;
  reach?: number;
  newFollows?: number;
}

export interface StoredAccount extends ConnectedAccount {
  /** The login's token for this account (a Facebook Page's own token, an Instagram account's user token…). */
  token?: string;
  refresh?: string;
  expiresAt?: number;
  /** Which app issued the login: this server's own (unset = local) or the sign-in service's. It renews only there. */
  issuer?: "local" | "service";
  /** Per-day counts kept across pulls (TikTok). Never sent to the browser, see publicAccount. */
  snapshots?: VideoSnapshot[];
  /** Each posted video's per-second pHashes by post id (an empty list = it could not be read). Never sent to the browser. */
  prints?: Record<string, string[]>;
  /** Each posted video's speech (lower case words, see similar.ts speechWords) by post id; [] = no speech or it could not be read. Never sent to the browser. */
  voices?: Record<string, string[]>;
  /** Per-day account insights kept across pulls (Instagram login), 90 days. Never sent to the browser, see publicAccount. */
  daily?: AccountDay[];
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

/** Any working Instagram login of this person (their own professional account), for Business Discovery reads of others. */
export function anyInstagramLogin(user: string): { token: string; userId: string } | null {
  const a = readConnectors(user).accounts.find((x) => x.platform === "instagram" && x.via === "login" && x.token && x.loginStatus !== "needs_reconnect" && !(x.expiresAt && x.expiresAt <= Date.now() && !x.refresh));
  return a?.token ? { token: a.token, userId: a.platformId } : null;
}

/** Public view: no tokens, no snapshot history, no fingerprints, no speech, no post media URLs, no daily history. */
export function publicAccount(a: StoredAccount): ConnectedAccount {
  const { token: _t, refresh: _r, expiresAt, snapshots: _s, prints: _p, voices: _v, daily: _d, ...rest } = a;
  const posts = rest.posts?.map(({ mediaUrl: _m, ...p }) => p);
  return { ...rest, ...(posts ? { posts } : {}), ...(expiresAt ? { loginExpiresAt: expiresAt } : {}) };
}

/**
 * Adds one day's pull to the history: that day's rows replace any earlier rows for the same posts (or the same
 * account, for AccountDay rows), and rows older than keepDays go, so the history stays bounded however often the
 * account is pulled.
 */
export function mergeSnapshots<T extends { day: string; id: string }>(prev: T[] | undefined, day: string, rows: T[], keepDays = 90): T[] {
  const cutoff = new Date(Date.parse(day) - keepDays * 86_400_000).toISOString().slice(0, 10);
  const pulled = new Set(rows.map((r) => r.id));
  const kept = (prev ?? []).filter((r) => r.day >= cutoff && !(r.day === day && pulled.has(r.id)));
  return [...kept, ...rows].sort((x, y) => x.day.localeCompare(y.day) || x.id.localeCompare(y.id));
}

export const newState = () => randomUUID();
export type { SocialPlatform };
