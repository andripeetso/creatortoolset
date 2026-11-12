import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Every sign-in route, for accounts that never switched the sign-in code on, answers what it answered before the code
// existed: status, body, the cookie's attributes and the headers a phone app reads. The answers were recorded from the
// server before the sign-in code (RECORD_SIGNIN_ANSWERS=1 writes the fixture), and this run compares with them. Cookie
// values hold a random salt's hash, so each is checked for its shape and that it signs in, then masked.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "sign-in-answers-"));
process.env.APP_SECRET = "sign-in-answers-test-secret";
process.env.CT_MODE = "hosted"; // mounts the invite routes; the own-computer half below switches it off per request
const FIXTURE = path.join(import.meta.dirname, "__fixtures__", "sign-in-answers.json");

const { createUser } = await import("./users");
const { mintAppCode } = await import("./auth");
const { findUser } = await import("./users");
const app = (await import("./boot")).default;

createUser("tina", "tina-password-1", { role: "user" });

afterEach(() => vi.unstubAllEnvs());

const req = (method: string, p: string, o: { address?: string; cookie?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.body !== undefined || o.raw !== undefined) headers["content-type"] = "application/json";
  const address = o.address ?? "127.0.0.1";
  return Promise.resolve(
    app.request(
      `http://localhost${p}`,
      { method, headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) },
      { incoming: { socket: { remoteAddress: address, remotePort: 50000, remoteFamily: address.includes(":") ? "IPv6" : "IPv4" } } },
    ),
  );
};
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

/** One answer as the fixture keeps it. */
async function seen(res: Response) {
  const set = res.headers.get("set-cookie");
  if (set && !/^cap_auth=(;|$)/.test(set)) {
    // a real cookie: it has the shape and it signs in
    expect(set).toMatch(/^cap_auth=[A-Za-z0-9_-]+\.[a-f0-9]{64};/);
    const check = (await (await req("GET", "/api/auth/check", { cookie: cookieOf(res) })).json()) as { authed: boolean };
    expect(check.authed).toBe(true);
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* a text answer */
  }
  return {
    status: res.status,
    body,
    cookie: set?.replace(/^cap_auth=[A-Za-z0-9_-]+\.[a-f0-9]{64}/, "cap_auth=<signed>") ?? null,
    location: res.headers.get("location"),
    cacheControl: res.headers.get("cache-control"),
  };
}

it("every sign-in route answers as it did before the sign-in code, for accounts without one", async () => {
  const out: Record<string, unknown> = {};

  // a server on this Mac (CT_LOCAL=1): the window's own sign-in, the LAN, the password change, one-time links
  vi.stubEnv("CT_MODE", "");
  vi.stubEnv("CT_LOCAL", "1");
  vi.stubEnv("HOST", "127.0.0.1");
  const SECRET = { username: "admin", password: "sign-in-answers-test-secret" };
  out["check, signed out"] = await seen(await req("GET", "/api/auth/check"));
  out["login, wrong password"] = await seen(await req("POST", "/api/auth/login", { body: { username: "admin", password: "nope" } }));
  out["login, no such account"] = await seen(await req("POST", "/api/auth/login", { body: { username: "nobody", password: "nope" } }));
  out["login, not JSON"] = await seen(await req("POST", "/api/auth/login", { raw: "{" }));
  out["login, the app's secret from the LAN"] = await seen(await req("POST", "/api/auth/login", { address: "203.0.113.7", body: SECRET }));
  const window = await req("POST", "/api/auth/login", { body: SECRET });
  const owner = cookieOf(window);
  out["login, this Mac's window"] = await seen(window);
  out["check, signed in"] = await seen(await req("GET", "/api/auth/check", { cookie: owner }));
  out["account"] = await seen(await req("GET", "/api/auth/account", { cookie: owner }));
  out["password, wrong current"] = await seen(await req("POST", "/api/auth/password", { cookie: owner, body: { current: "nope", password: "tinyacrobatics-owner" } }));
  const changed = await req("POST", "/api/auth/password", { cookie: owner, body: { current: SECRET.password, password: "tinyacrobatics-owner" } });
  const owner2 = cookieOf(changed);
  out["password, changed"] = await seen(changed);
  out["check, the old cookie after the change"] = await seen(await req("GET", "/api/auth/check", { cookie: owner }));
  out["login, from the LAN with the owner's password"] = await seen(await req("POST", "/api/auth/login", { address: "203.0.113.7", body: { username: "admin", password: "tinyacrobatics-owner" } }));
  const minted = (await (await req("POST", "/api/auth/link", { cookie: owner2 })).json()) as { url: unknown; path: string; expiresAt: number };
  out["link, minted"] = { url: minted.url, path: /^\/api\/auth\/link\/[A-Za-z0-9_-]{43}$/.test(minted.path), expiresAt: typeof minted.expiresAt };
  const link = await req("GET", minted.path, { address: "203.0.113.7" });
  out["link, opened on a phone"] = { ...(await seen(link)), referrer: link.headers.get("referrer-policy") };
  out["link, opened again"] = await seen(await req("GET", minted.path, { address: "203.0.113.7" }));
  out["ticket, not a tunnel address"] = await seen(await req("POST", "/api/auth/ticket", { body: { ticket: "x", password: "y" } }));
  out["logout"] = await seen(await req("POST", "/api/auth/logout", { cookie: owner2 }));

  // a hosted server: a member's password sign-in, an app's code swap, an invite that makes an account
  vi.stubEnv("CT_MODE", "hosted");
  vi.stubEnv("CT_LOCAL", "");
  const tina = await req("POST", "/api/auth/login", { address: "198.51.100.4", body: { username: "tina", password: "tina-password-1" } });
  out["hosted login"] = await seen(tina);
  out["hosted app, no code"] = await seen(await req("POST", "/api/auth/app", { body: {} }));
  const verifier = "w".repeat(43);
  const code = mintAppCode(findUser("tina")!, createHash("sha256").update(verifier).digest("base64url"));
  out["hosted app, its code"] = await seen(await req("POST", "/api/auth/app", { body: { code, verifier } }));
  const adminCookie = cookieOf(await req("POST", "/api/auth/login", { body: { username: "admin", password: "tinyacrobatics-owner" } }));
  const made = (await (await req("POST", "/api/workspace/invites", { cookie: adminCookie, body: { ai: "own", budgetUsd: 0 } })).json()) as { token: string };
  out["hosted invite, a new account"] = await seen(await req("POST", `/api/auth/invite/${made.token}`, { address: "198.51.100.5", body: { username: "tomas", password: "tomas-password-1" } }));

  if (process.env.RECORD_SIGNIN_ANSWERS === "1") writeFileSync(FIXTURE, `${JSON.stringify(out, null, 2)}\n`);
  expect(existsSync(FIXTURE)).toBe(true);
  expect(out).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
});
