import { hostname } from "node:os";
import path from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { env } from "./env";

/**
 * "I already have a server": this computer joins another server as a device of the account that signs in there.
 * The other server's Devices page mints a one-time sign-in link (POST /api/auth/link, 60 s, single use). Pasted here,
 * this server opens it once (no redirects followed), keeps the cookie it is given, and asks for a device with it
 * (POST /api/devices). The device token is kept in a file only this server's user can read; it never goes to the page.
 * Fails closed: https, or plain http on this network only, the link's own path only, no redirects, a short timeout.
 */

const LINK_PATH = /^\/api\/auth\/link\/[A-Za-z0-9_-]{20,200}$/;
const LAN = /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local)$/i;
const TIMEOUT_MS = 8_000;

export type JoinLink = { origin: string; url: string };
export type JoinResult =
  | { ok: true; server: string; device: { id: string; name: string }; token: string }
  | { ok: false; message: string };

/** The link as pasted, or null when it is not a sign-in link of another server. */
export function parseJoinLink(raw: unknown): JoinLink | null {
  if (typeof raw !== "string" || raw.length > 600) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LAN.test(u.hostname))) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (!LINK_PATH.test(u.pathname)) return null;
  return { origin: u.origin, url: `${u.origin}${u.pathname}` };
}

const fail = (message: string): JoinResult => ({ ok: false, message });

/** The body of an answer, as text, trimmed and short: the other server's own words for a refusal. */
async function words(r: Response): Promise<string> {
  const t = await r.text().catch(() => "");
  return t.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Joins the other server behind a pasted link. `fetchImpl` is for tests; the caller passes the device name. */
export async function joinServer(raw: unknown, opts: { fetchImpl?: typeof fetch; name?: string } = {}): Promise<JoinResult> {
  const link = parseJoinLink(raw);
  if (!link) return fail("That isn't a sign-in link from another server. Copy the whole link from its Devices page.");
  const f = opts.fetchImpl ?? fetch;
  let r: Response;
  try {
    r = await f(link.url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return fail("Couldn't reach that server. Check its address and that it is running.");
  }
  if (r.status !== 302) {
    const why = await words(r);
    return fail(why || "That link didn't sign this computer in. Ask for a new one.");
  }
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!.trim())
    .filter((c) => c.includes("="))
    .join("; ");
  if (!cookie) return fail("That server didn't sign this computer in. Ask for a new link.");

  let d: Response;
  try {
    d = await f(`${link.origin}/api/devices`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: opts.name ?? hostname() }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return fail("Signed in, but that server didn't answer when adding this computer. Try again.");
  }
  const body = (await d.json().catch(() => null)) as { device?: { id?: unknown; name?: unknown }; token?: unknown; error?: unknown } | null;
  if (!d.ok || typeof body?.token !== "string" || typeof body.device?.id !== "string") {
    return fail(typeof body?.error === "string" ? body.error : "That server didn't add this computer.");
  }
  return {
    ok: true,
    server: link.origin,
    device: { id: body.device.id, name: typeof body.device.name === "string" ? body.device.name : hostname() },
    token: body.token,
  };
}

/** Where a joined server's token is kept for this account: DATA_DIR/join/<user>.json, owner-only. */
const joinFile = (user: string) => path.join(env.dataDir, "join", `${user}.json`);

export interface JoinRecord {
  server: string;
  device: { id: string; name: string };
  token: string;
  at: number;
}

/** Keeps the joined server (replacing one for the same origin). Owner-only file, written whole then renamed. */
export function saveJoin(user: string, rec: JoinRecord): void {
  const f = joinFile(user);
  const kept = readJoins(user).filter((x) => x.server !== rec.server);
  mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(`${f}.tmp`, JSON.stringify([...kept, rec]), { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
}

export function readJoins(user: string): JoinRecord[] {
  try {
    return JSON.parse(readFileSync(joinFile(user), "utf-8")) as JoinRecord[];
  } catch {
    return [];
  }
}
