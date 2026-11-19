import { generateKeyPairSync, randomUUID, sign, createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// What can't sign each request (a player, a web view, a background upload) carries a short ticket of its session,
// scoped to one path and to reading or writing there, and gone with the session.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "media-ticket-"));
process.env.APP_SECRET = "media-ticket-test-secret";
process.env.CT_LOCAL = "1";

const app = (await import("./boot")).default;

type Opts = { headers?: Record<string, string>; body?: unknown; form?: Record<string, string>; cookie?: string; token?: string };
function call(method: string, p: string, o: Opts = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.token) headers.authorization ??= `Bearer ${o.token}`;
  let body: string | undefined;
  if (o.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(o.form).toString();
  } else if (o.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.body);
  }
  return app.request(`http://localhost${p}`, { method, headers, body }, { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50000, remoteFamily: "IPv4" } } });
}

const key = (() => {
  const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j = k.publicKey.export({ format: "jwk" }) as Record<string, string>;
  return { privateKey: k.privateKey, jwk: { kty: j.kty, crv: j.crv, x: j.x, y: j.y } };
})();
function dpop(htm: string, htu: string, token?: string) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = b64({ typ: "dpop+jwt", alg: "ES256", jwk: key.jwk });
  const p = b64({ htm, htu, iat: Math.floor(Date.now() / 1000), jti: randomUUID(), ...(token ? { ath: createHash("sha256").update(token).digest("base64url") } : {}) });
  return `${h}.${p}.${sign("sha256", Buffer.from(`${h}.${p}`), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

/** Where each use rides: a `media` ticket in the cookie (players, web views), an `upload` one in the header. */
const media = (t: string) => `ct_ticket=${t}`;
const upload = (t: string) => ({ "x-ct-ticket": t });

let cookie = "";
async function pair(scopes: string[] = ["read", "write", "access"], withKey = false) {
  const link = (await (await call("POST", "/api/auth/pairing-links", { cookie, body: { scopes } })).json()) as { credential: string };
  const r = await call("POST", "/oauth/token", {
    headers: withKey ? { dpop: dpop("POST", "http://localhost/oauth/token") } : {},
    form: {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: link.credential,
      subject_token_type: "urn:creatortoolset:params:oauth:token-type:server-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    },
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const ask = async (token: string, body: unknown, dpopKey = false, use = "media") => {
  const url = `/api/auth/media-ticket/${use}`;
  const headers = dpopKey ? { authorization: `DPoP ${token}`, dpop: dpop("POST", `http://localhost${url}`, token) } : { authorization: `Bearer ${token}` };
  return call("POST", url, { headers, body });
};
const mint = async (token: string, path: string, use = "media") =>
  ((await (await ask(token, { path }, false, use)).json()) as { ticket: string }).ticket;

beforeAll(async () => {
  const r = await call("POST", "/api/auth/login", { body: { username: "admin", password: process.env.APP_SECRET } });
  expect(r.status).toBe(200);
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
});

afterEach(() => vi.useRealTimers());

describe("media tickets", () => {
  it("a DPoP session gets one for a path, and a player's plain GET under it is signed in by the cookie", async () => {
    const token = await pair(undefined, true);
    const r = await ask(token, { path: "/api/workshop" }, true);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const t = (await r.json()) as { ticket: string; use: string; expiresAt: string; write: boolean };
    expect(t.ticket).toMatch(/^ctm_[A-Za-z0-9_-]{43}$/);
    expect(t.use).toBe("media");
    expect(t.write).toBe(false);
    // no header at all, many times over (range requests)
    for (let i = 0; i < 3; i++) expect((await call("GET", "/api/workshop/workspace", { cookie: media(t.ticket) })).status).toBe(200);
    expect((await call("GET", "/api/workshop/workspace")).status).toBe(401);
  });

  it("is never read from the URL", async () => {
    const token = await pair();
    const m = await mint(token, "/api/workshop");
    const u = await mint(token, "/api/workshop", "upload");
    for (const t of [m, u]) expect((await call("GET", `/api/workshop/workspace?ct_ticket=${t}`)).status).toBe(401);
    // the same ticket where it belongs still works
    expect((await call("GET", `/api/workshop/workspace?ct_ticket=${m}`, { cookie: media(m) })).status).toBe(200);
  });

  it("works only for its own use: media in the cookie, upload in the header", async () => {
    const token = await pair();
    const m = await mint(token, "/api/workshop");
    const u = await mint(token, "/api/workshop", "upload");
    expect((await call("GET", "/api/workshop/workspace", { headers: upload(u) })).status).toBe(200);
    expect((await call("GET", "/api/workshop/workspace", { headers: upload(m) })).status).toBe(401);
    expect((await call("GET", "/api/workshop/workspace", { cookie: media(u) })).status).toBe(401);
    // an upload ticket never signs a web view in
    expect(((await (await call("GET", "/api/auth/check", { cookie: media(u) })).json()) as { authed: boolean }).authed).toBe(false);
    // an upload step always writes; the bare path and an unknown use mint nothing
    expect(((await (await ask(token, { path: "/api/workshop" }, false, "upload")).json()) as { write: boolean }).write).toBe(true);
    expect((await call("POST", "/api/auth/media-ticket", { token, body: { path: "/api/workshop" } })).status).toBe(404);
    expect((await ask(token, { path: "/api/workshop" }, false, "rpc")).status).toBe(404);
  });

  it("runs out after 5 minutes, though its session lives on", async () => {
    const token = await pair();
    const r = (await (await ask(token, { path: "/api/workshop" })).json()) as { ticket: string; expiresAt: string };
    const left = Date.parse(r.expiresAt) - Date.now();
    expect(left).toBeLessThanOrEqual(5 * 60_000);
    expect(left).toBeGreaterThan(4 * 60_000);
    const u = await mint(token, "/api/workshop", "upload");
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 4 * 60_000 });
    expect((await call("GET", "/api/workshop/workspace", { cookie: media(r.ticket) })).status).toBe(200);
    expect((await call("GET", "/api/workshop/workspace", { headers: upload(u) })).status).toBe(200);
    vi.setSystemTime(Date.now() + 60_000 + 1);
    expect((await call("GET", "/api/workshop/workspace", { cookie: media(r.ticket) })).status).toBe(401);
    expect((await call("GET", "/api/workshop/workspace", { headers: upload(u) })).status).toBe(401);
    expect((await call("GET", "/api/workshop/workspace", { token })).status).toBe(200);
  });

  it("opens only its own path, reading only, never sign-in or access routes", async () => {
    const token = await pair();
    const t = await mint(token, "/api/workshop/workspace");
    expect((await call("GET", "/api/workshop/workspacex", { cookie: media(t) })).status).toBe(401);
    expect((await call("GET", "/api/library", { cookie: media(t) })).status).toBe(401);
    expect((await call("POST", "/api/workshop/workspace", { cookie: media(t), body: {} })).status).toBe(401);
    for (const p of ["/api/auth/access", "/api/connect/relay-config", "/api/../api/auth", "/api/x?y", "/web", "/api/auth"]) {
      expect((await ask(token, { path: p })).status).toBe(400);
    }
    const wide = await mint(token, "/api/");
    expect((await call("GET", "/api/auth/access", { cookie: media(wide) })).status).toBe(401);
    // what a device session may never open, a ticket of one may not either
    for (const p of ["/api/providers", "/api/my-keys", "/api/admin/users"]) expect((await call("GET", p, { cookie: media(wide) })).status).toBe(403);
  });

  it("a write ticket opens every method there, only for a session that may write", async () => {
    const reader = await pair(["read"]);
    expect((await ask(reader, { path: "/api/library/uploads/u1", write: true })).status).toBe(403);
    expect((await ask(reader, { path: "/api/library/uploads/u1" }, false, "upload")).status).toBe(403);
    const writer = await pair(["read", "write"]);
    const t = await mint(writer, "/api/workshop", "upload");
    // past the gate (whatever the route answers, it is not the gate's 401)
    expect((await call("POST", "/api/workshop/workspace", { headers: upload(t), body: {} })).status).not.toBe(401);
  });

  it("a web view's cookie carries it, and /api/auth/check counts it as signed in", async () => {
    const token = await pair();
    const t = await mint(token, "/api/");
    const check = (await (await call("GET", "/api/auth/check", { cookie: media(t) })).json()) as { authed: boolean; user: { username: string } };
    expect(check.authed).toBe(true);
    expect(check.user.username).toBe("admin");
    expect((await call("GET", "/api/workshop/workspace", { cookie: media(t) })).status).toBe(200);
    expect(((await (await call("GET", "/api/auth/check")).json()) as { authed: boolean }).authed).toBe(false);
  });

  it("ends with its session, and a browser cookie or no sign-in gets none", async () => {
    const token = await pair();
    const m = await mint(token, "/api/workshop");
    const u = await mint(token, "/api/workshop", "upload");
    const sessions = ((await (await call("GET", "/api/auth/access", { token })).json()) as { clientSessions: Array<{ sessionId: string; current: boolean }> }).clientSessions;
    const own = sessions.find((s) => s.current)!;
    expect((await call("POST", "/api/auth/clients/revoke", { cookie, body: { sessionId: own.sessionId } })).status).toBe(200);
    expect((await call("GET", "/api/workshop/workspace", { cookie: media(m) })).status).toBe(401);
    expect((await call("GET", "/api/workshop/workspace", { headers: upload(u) })).status).toBe(401);
    expect((await call("POST", "/api/auth/media-ticket/media", { cookie, body: { path: "/api/workshop" } })).status).toBe(400);
    expect((await call("POST", "/api/auth/media-ticket/media", { body: { path: "/api/workshop" } })).status).toBe(401);
  });
});
