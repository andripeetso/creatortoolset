import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env";

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,23}$/;

/**
 * The burner account's browser session. Cookies are pasted per logged-in
 * user at $DATA_DIR/instagram/users/<username>/session.json (mode 0600).
 * They are never logged and never returned to a client — only status is.
 *
 * INSTAGRAM_COOKIE in .env is a local-only fallback for the `local` user
 * when APP_SECRET is unset. Production accounts never inherit env cookies.
 */

export const IG_ROOT = path.join(env.dataDir, "instagram");
const LEGACY_SESSION = path.join(IG_ROOT, "session.json");
const LEGACY_SOURCE = path.join(IG_ROOT, "source.json");

/** Per-user credential directory. Usernames match the accounts file. */
export function igCredsDir(username: string): string {
  const u = username.toLowerCase();
  if (!USERNAME_RE.test(u)) throw new Error("Invalid username");
  return path.join(IG_ROOT, "users", u);
}

export function igUserFile(username: string, name: string): string {
  return path.join(igCredsDir(username), name);
}

/**
 * Move a leftover global secret into this user's folder when they are
 * the original saver. Other users get nothing from the global file.
 */
export async function adoptLegacyIfOwner(
  username: string,
  legacyPath: string,
  destName: string,
): Promise<boolean> {
  const dest = igUserFile(username, destName);
  try {
    await readFile(dest);
    return false;
  } catch {
    /* dest missing */
  }
  try {
    const raw = JSON.parse(await readFile(legacyPath, "utf-8")) as { savedBy?: unknown };
    if (typeof raw.savedBy !== "string" || raw.savedBy !== username) return false;
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(legacyPath, dest);
    return true;
  } catch {
    return false;
  }
}

/** Take the leftover global source.json only when this user just adopted a secret. */
export async function adoptLegacySource(username: string): Promise<void> {
  const dest = igUserFile(username, "source.json");
  try {
    await readFile(dest);
    return;
  } catch {
    /* dest missing */
  }
  try {
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(LEGACY_SOURCE, dest);
  } catch {
    /* no leftover */
  }
}

export const REQUIRED_COOKIES = ["sessionid", "csrftoken", "ds_user_id"] as const;
export const IG_APP_ID = "936619743392459";
export const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const PROBE_URL =
  "https://www.instagram.com/api/v1/users/web_profile_info/?username=instagram";
const ACCOUNT_URL = (id: string) =>
  `https://www.instagram.com/api/v1/users/${encodeURIComponent(id)}/info/`;

export interface SessionCookie {
  name: string;
  value: string;
}

export interface StoredSession {
  cookies: SessionCookie[];
  savedAt: number;
  savedBy: string;
  /** null = never checked */
  valid: boolean | null;
  checkedAt?: number;
  account?: { id: string; username?: string };
  invalidReason?: string;
  source: "file" | "env";
}

export interface SessionStatus {
  configured: boolean;
  valid: boolean | null;
  checkedAt?: number;
  savedAt?: number;
  savedBy?: string;
  account?: { id: string; username?: string };
  invalidReason?: string;
  source: "file" | "env" | "none";
}

function dedupe(cookies: SessionCookie[]): SessionCookie[] {
  const map = new Map<string, string>();
  for (const c of cookies) map.set(c.name, c.value);
  return [...map].map(([name, value]) => ({ name, value }));
}

/**
 * Accepts a Cookie request header ("a=b; c=d"), a Netscape cookies.txt
 * export, or a JSON array of {name, value} / object of name → value.
 */
export function parseCookieInput(text: string): SessionCookie[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const out: SessionCookie[] = [];
      if (Array.isArray(parsed)) {
        for (const c of parsed) {
          const rec = c as { name?: unknown; value?: unknown };
          if (typeof rec?.name === "string" && typeof rec?.value === "string") {
            out.push({ name: rec.name.trim(), value: rec.value.trim() });
          }
        }
      } else if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") out.push({ name: k.trim(), value: v.trim() });
        }
      }
      return dedupe(out.filter((c) => c.name && c.value));
    } catch {
      /* not JSON after all — fall through */
    }
  }

  const netscape: SessionCookie[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const cols = line.split("\t");
    if (cols.length < 7) continue;
    if (!/instagram\.com$/i.test(cols[0].trim())) continue;
    const name = cols[5].trim();
    const value = cols[6].trim();
    if (name && value) netscape.push({ name, value });
  }
  if (netscape.length) return dedupe(netscape);

  const header = trimmed.replace(/^cookie:\s*/i, "");
  const out: SessionCookie[] = [];
  for (const part of header.split(/;\s*|\r?\n/)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part
      .slice(i + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (name && value) out.push({ name, value });
  }
  return dedupe(out);
}

export function missingCookies(cookies: SessionCookie[]): string[] {
  const have = new Set(cookies.map((c) => c.name));
  return REQUIRED_COOKIES.filter((n) => !have.has(n));
}

export function cookieValue(s: StoredSession, name: string): string {
  return s.cookies.find((c) => c.name === name)?.value ?? "";
}

export function cookieHeader(s: StoredSession): string {
  return s.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Headers Instagram's web client sends to its own JSON endpoints. */
export function igHeaders(
  s: StoredSession,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "User-Agent": DESKTOP_UA,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: cookieHeader(s),
    "X-IG-App-ID": IG_APP_ID,
    "X-Requested-With": "XMLHttpRequest",
    "X-CSRFToken": cookieValue(s, "csrftoken"),
    "X-ASBD-ID": "129477",
    "X-IG-WWW-Claim": "0",
    Referer: "https://www.instagram.com/",
    ...extra,
  };
}

let envSession: StoredSession | null | undefined;
let writeQ: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQ.then(fn, fn);
  writeQ = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Env cookies only seed the local (no APP_SECRET) identity. */
function fromEnv(username: string): StoredSession | null {
  if (username !== "local" || env.appSecret) return null;
  if (envSession !== undefined) return envSession;
  const raw = process.env.INSTAGRAM_COOKIE || "";
  const cookies = parseCookieInput(raw);
  envSession =
    cookies.length && !missingCookies(cookies).length
      ? {
          cookies,
          savedAt: 0,
          savedBy: "env",
          valid: null,
          account: { id: cookieValue({ cookies } as StoredSession, "ds_user_id") },
          source: "env",
        }
      : null;
  return envSession;
}

export async function readSession(username: string): Promise<StoredSession | null> {
  const adopted = await adoptLegacyIfOwner(username, LEGACY_SESSION, "session.json");
  if (adopted) await adoptLegacySource(username);
  try {
    const raw = JSON.parse(await readFile(igUserFile(username, "session.json"), "utf-8")) as StoredSession;
    if (!Array.isArray(raw?.cookies)) return fromEnv(username);
    return { ...raw, source: "file" };
  } catch {
    return fromEnv(username);
  }
}

async function writeFileAtomic(target: string, data: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, target);
}

export function writeSession(username: string, s: StoredSession): Promise<void> {
  return serialized(async () => {
    if (s.source === "env") {
      if (username === "local") envSession = s;
      return;
    }
    await writeFileAtomic(igUserFile(username, "session.json"), JSON.stringify(s));
  });
}

export function clearSession(username: string): Promise<void> {
  return serialized(async () => {
    await rm(igUserFile(username, "session.json"), { force: true }).catch(() => {});
    if (username === "local") envSession = null;
  });
}

export async function updateSession(
  username: string,
  patch: (s: StoredSession) => StoredSession,
): Promise<StoredSession | null> {
  const s = await readSession(username);
  if (!s) return null;
  const next = patch(s);
  await writeSession(username, next);
  return next;
}

export function markInvalid(username: string, reason: string): Promise<StoredSession | null> {
  if (!username) return Promise.resolve(null);
  console.warn(`[instagram] session marked invalid: ${reason}`);
  return updateSession(username, (s) => ({
    ...s,
    valid: false,
    checkedAt: Date.now(),
    invalidReason: reason.slice(0, 200),
  }));
}

export function publicSessionStatus(s: StoredSession | null): SessionStatus {
  if (!s) return { configured: false, valid: null, source: "none" };
  return {
    configured: true,
    valid: s.valid,
    checkedAt: s.checkedAt,
    savedAt: s.savedAt || undefined,
    savedBy: s.savedBy,
    account: s.account,
    invalidReason: s.invalidReason,
    source: s.source,
  };
}

/**
 * Cheap validity probe: a JSON answer from a logged-in-only endpoint means
 * the cookies work; HTML, a redirect, or 401/403 means the login wall.
 */
export async function checkSession(
  username: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredSession | null> {
  const s = await readSession(username);
  if (!s) return null;
  let valid = false;
  let reason: string | undefined;
  let accountUsername: string | undefined;
  try {
    const res = await fetchImpl(PROBE_URL, {
      headers: igHeaders(s),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const ct = res.headers.get("content-type") || "";
    if (res.ok && ct.includes("json")) {
      const j = (await res.json().catch(() => null)) as {
        data?: { user?: unknown };
      } | null;
      valid = !!j?.data?.user;
      if (!valid) reason = "Unexpected response from Instagram";
    } else {
      await res.body?.cancel().catch(() => {});
      reason =
        res.status === 429
          ? "Rate limited by Instagram — try again later"
          : `Login wall (HTTP ${res.status}) — the cookies are expired or logged out`;
    }
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  if (valid) {
    const id = cookieValue(s, "ds_user_id");
    try {
      const res = await fetchImpl(ACCOUNT_URL(id), {
        headers: igHeaders(s),
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok && (res.headers.get("content-type") || "").includes("json")) {
        const j = (await res.json().catch(() => null)) as {
          user?: { username?: string };
        } | null;
        if (typeof j?.user?.username === "string") accountUsername = j.user.username;
      } else {
        await res.body?.cancel().catch(() => {});
      }
    } catch {
      /* the username is cosmetic */
    }
  }
  const next: StoredSession = {
    ...s,
    valid,
    checkedAt: Date.now(),
    invalidReason: valid ? undefined : reason,
    account: {
      id: cookieValue(s, "ds_user_id"),
      username: accountUsername ?? (valid ? s.account?.username : undefined),
    },
  };
  await writeSession(username, next);
  return next;
}
