import { generateKeyPairSync, randomUUID, sign, createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

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
const ask = async (token: string, body: unknown, dpopKey = false) => {
  const headers = dpopKey ? { authorization: `DPoP ${token}`, dpop: dpop("POST", "http://localhost/api/auth/media-ticket", token) } : { authorization: `Bearer ${token}` };
  return call("POST", "/api/auth/media-ticket", { headers, body });
};

beforeAll(async () => {
  const r = await call("POST", "/api/auth/login", { body: { username: "admin", password: process.env.APP_SECRET } });
  expect(r.status).toBe(200);
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
});

describe("media tickets", () => {
  it("a DPoP session gets one for a path, and a player's plain GET under it is signed in", async () => {
    const token = await pair(undefined, true);
    const r = await ask(token, { path: "/api/workshop" }, true);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const t = (await r.json()) as { ticket: string; expiresAt: string; write: boolean };
    expect(t.ticket).toMatch(/^ctm_[A-Za-z0-9_-]{43}$/);
    expect(t.write).toBe(false);
    expect(Date.parse(t.expiresAt) - Date.now()).toBeLessThanOrEqual(3600_000);
    // no header at all, many times over (range requests)
    for (let i = 0; i < 3; i++) expect((await call("GET", `/api/workshop/workspace?ct_ticket=${t.ticket}`)).status).toBe(200);
    expect((await call("GET", "/api/workshop/workspace")).status).toBe(401);
  });

  it("opens only its own path, reading only, never sign-in or access routes", async () => {
    const token = await pair();
    const t = ((await (await ask(token, { path: "/api/workshop/workspace" })).json()) as { ticket: string }).ticket;
    expect((await call("GET", `/api/workshop/workspacex?ct_ticket=${t}`)).status).toBe(401);
    expect((await call("GET", `/api/library?ct_ticket=${t}`)).status).toBe(401);
    expect((await call("POST", `/api/workshop/workspace?ct_ticket=${t}`, { body: {} })).status).toBe(401);
    for (const p of ["/api/auth/access", "/api/connect/relay-config", "/api/../api/auth", "/api/x?y", "/web", "/api/auth"]) {
      expect((await ask(token, { path: p })).status).toBe(400);
    }
    const wide = ((await (await ask(token, { path: "/api/" })).json()) as { ticket: string }).ticket;
    expect((await call("GET", `/api/auth/access?ct_ticket=${wide}`)).status).toBe(401);
  });

  it("a write ticket opens every method there, only for a session that may write", async () => {
    const reader = await pair(["read"]);
    expect((await ask(reader, { path: "/api/library/uploads/u1", write: true })).status).toBe(403);
    const writer = await pair(["read", "write"]);
    const t = ((await (await ask(writer, { path: "/api/workshop", write: true })).json()) as { ticket: string }).ticket;
    // past the gate (whatever the route answers, it is not the gate's 401)
    expect((await call("POST", `/api/workshop/workspace?ct_ticket=${t}`, { body: {} })).status).not.toBe(401);
  });

  it("a web view's cookie carries it, and /api/auth/check counts it as signed in", async () => {
    const token = await pair();
    const t = ((await (await ask(token, { path: "/api/" })).json()) as { ticket: string }).ticket;
    const check = (await (await call("GET", "/api/auth/check", { cookie: `ct_ticket=${t}` })).json()) as { authed: boolean; user: { username: string } };
    expect(check.authed).toBe(true);
    expect(check.user.username).toBe("admin");
    expect((await call("GET", "/api/workshop/workspace", { cookie: `ct_ticket=${t}` })).status).toBe(200);
    expect(((await (await call("GET", "/api/auth/check")).json()) as { authed: boolean }).authed).toBe(false);
  });

  it("ends with its session, and a browser cookie or no sign-in gets none", async () => {
    const token = await pair();
    const t = ((await (await ask(token, { path: "/api/workshop" })).json()) as { ticket: string }).ticket;
    const sessions = ((await (await call("GET", "/api/auth/access", { token })).json()) as { clientSessions: Array<{ sessionId: string; current: boolean }> }).clientSessions;
    const own = sessions.find((s) => s.current)!;
    expect((await call("POST", "/api/auth/clients/revoke", { cookie, body: { sessionId: own.sessionId } })).status).toBe(200);
    expect((await call("GET", `/api/workshop/workspace?ct_ticket=${t}`)).status).toBe(401);
    expect((await call("POST", "/api/auth/media-ticket", { cookie, body: { path: "/api/workshop" } })).status).toBe(400);
    expect((await call("POST", "/api/auth/media-ticket", { body: { path: "/api/workshop" } })).status).toBe(401);
  });
});
