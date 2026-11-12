import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A computer on the connect broker, end to end against a fake broker that speaks the broker's protocol (the device
// grant, the link, the ticket). The "second machine" signs in through the tunnel hostname with a ticket.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "connect-"));
process.env.APP_SECRET = "local-sign-in-test-secret";
process.env.CT_CONNECT_URL = "https://broker.test";

const app = (await import("../boot")).default;

const ZONE = "tunnels.test.example";
const relay = generateKeyPairSync("ed25519");
const relayB64 = relay.publicKey.export({ type: "spki", format: "der" }).toString("base64");

// The broker's ticket: Ed25519 over the base64url JSON body, the same bytes the computer verifies.
function issue(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${sign(null, Buffer.from(body), relay.privateKey).toString("base64url")}`;
}

const broker = {
  approved: false,
  tokens: new Map<string, string>(), // access token -> account id
  nonces: new Map<string, string>(), // challenge -> account id
  computers: new Map<string, { sub: string; hostname: string }>(),
  lastToken: "",
};

const mint = (sub: string) => {
  const t = `${Buffer.from(JSON.stringify({ sub, exp: 9_999_999_999 })).toString("base64url")}.sig`;
  broker.tokens.set(t, sub);
  broker.lastToken = t;
  return t;
};

async function fakeBroker(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (req.method === "POST" && u.pathname === "/oauth/device") {
    return json(200, { device_code: "device-1", user_code: "BCDF-GHJK", verification_uri: "https://broker.test/connect", verification_uri_complete: "https://broker.test/connect?code=BCDF-GHJK", interval: 5, expires_in: 600 });
  }
  if (req.method === "POST" && u.pathname === "/oauth/token") {
    if (!broker.approved) return json(400, { error: "authorization_pending" });
    return json(200, { access_token: mint("acct-1"), token_type: "Bearer", expires_in: 3600 });
  }
  const sub = broker.tokens.get((req.headers.get("authorization") ?? "").replace(/^Bearer /, "")) ?? "";
  if (!sub) return json(401, { error: "unauthorized" });
  if (req.method === "POST" && u.pathname === "/v1/computers") {
    const nonce = randomBytes(16).toString("base64url");
    broker.nonces.set(nonce, sub);
    return json(200, { nonce, expires_in: 120 });
  }
  if (req.method === "POST" && u.pathname === "/v1/computers/link") {
    const b = (await req.json()) as { public_key: string; payload: string; signature: string };
    const key = createPublicKey({ key: Buffer.from(b.public_key, "base64"), format: "der", type: "spki" });
    if (!verify(null, Buffer.from(b.payload), key, Buffer.from(b.signature, "base64"))) return json(401, { error: "bad_signature" });
    const p = JSON.parse(b.payload) as { nonce: string };
    if (broker.nonces.get(p.nonce) !== sub) return json(401, { error: "bad_challenge" });
    broker.nonces.delete(p.nonce);
    const id = createHash("sha256").update(Buffer.from(b.public_key, "base64")).digest("hex").slice(0, 32);
    const hostname = `${id}.${ZONE}`;
    broker.computers.set(id, { sub, hostname });
    return json(200, { computer_id: id, hostname, tunnel_token: "tunnel-token", relay_kid: "kid-1", relay_public_key: relayB64 });
  }
  const t = /^\/v1\/computers\/([0-9a-f]{32})\/ticket$/.exec(u.pathname);
  if (t && req.method === "POST") {
    const c = broker.computers.get(t[1]!);
    if (!c || c.sub !== sub) return json(404, { error: "not_found" });
    const now = Math.floor(Date.now() / 1000);
    return json(200, { ticket: issue({ sub, env: t[1], aud: c.hostname, iat: now, exp: now + 120, jti: randomBytes(12).toString("base64url") }) });
  }
  return json(404, { error: "not_found" });
}

/** A request as if it came in on a socket from `address` (what getConnInfo reads); `host` makes it a tunnel or other name. */
function call(method: string, p: string, o: { address?: string; host?: string; headers?: Record<string, string>; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const url = `${o.host ? `https://${o.host}` : "http://localhost"}${p}`;
  const address = o.address ?? "127.0.0.1";
  return app.request(
    url,
    { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) },
    { incoming: { socket: { remoteAddress: address, remotePort: 50000, remoteFamily: address.includes(":") ? "IPv6" : "IPv4" } } },
  );
}
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const ADMIN = { username: "admin", password: "local-sign-in-test-secret" };

let adminCookie = "";
let hostname = "";

beforeAll(async () => {
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => fakeBroker(new Request(input, init)));
  adminCookie = cookieOf(await call("POST", "/api/auth/login", { body: ADMIN }));
  expect(adminCookie).not.toBe("");
  const started = await call("POST", "/api/connect/start", { cookie: adminCookie });
  expect(started.status).toBe(200);
  expect(await started.json()).toMatchObject({ user_code: "BCDF-GHJK", verification_uri_complete: "https://broker.test/connect?code=BCDF-GHJK" });
  // still waiting for approval
  expect(await (await call("POST", "/api/connect/poll", { cookie: adminCookie })).json()).toEqual({ status: "pending" });
  broker.approved = true;
  const polled = (await (await call("POST", "/api/connect/poll", { cookie: adminCookie })).json()) as { status: string; hostname: string };
  expect(polled.status).toBe("linked");
  hostname = polled.hostname;
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("a local server links to the broker", () => {
  it("records the tunnel hostname the broker made, and only the owner may link", async () => {
    const state = (await (await call("GET", "/api/connect", { cookie: adminCookie })).json()) as { linked: boolean; hostname: string };
    expect(state).toMatchObject({ linked: true, hostname });
    expect(hostname).toMatch(new RegExp(`^[0-9a-f]{32}\\.${ZONE.replace(/\./g, "\\.")}$`));
    expect((await call("GET", "/api/connect")).status).toBe(401);
    expect((await call("POST", "/api/connect/start", { cookie: adminCookie })).status).toBe(409);
  });
});

describe("a request that came through the tunnel is remote, even from 127.0.0.1", () => {
  it("refuses the APP_SECRET password on a tunnel request, and accepts it on a plain loopback request", async () => {
    vi.stubEnv("CT_LOCAL", "1");
    // a plain loopback login is local: allowed while the password is still APP_SECRET
    expect((await call("POST", "/api/auth/login", { body: ADMIN })).status).toBe(200);
    // cloudflared dials from loopback, but carries the tunnel's headers: remote
    const viaHeaders = await call("POST", "/api/auth/login", { body: ADMIN, headers: { "cf-connecting-ip": "203.0.113.9", "cf-ray": "8f00-SIN" } });
    expect(viaHeaders.status).toBe(403);
    // and a request addressed to the tunnel name is remote even with no tunnel headers
    expect((await call("POST", "/api/auth/login", { body: ADMIN, host: hostname })).status).toBe(403);
  });

  it("refuses a Host that is not this computer's name", async () => {
    expect((await call("GET", "/api/auth/check", { host: "other.example" })).status).toBe(400);
  });
});

describe("a second machine signs in through the tunnel with a ticket", () => {
  const ticketFor = async () => {
    const id = hostname.split(".")[0];
    const r = await fakeBroker(new Request(`https://broker.test/v1/computers/${id}/ticket`, { method: "POST", headers: { authorization: `Bearer ${broker.lastToken}` } }));
    return ((await r.json()) as { ticket: string }).ticket;
  };
  const signIn = (ticket: string, password: string) =>
    call("POST", "/api/auth/ticket", { host: hostname, headers: { "cf-connecting-ip": "203.0.113.9", "cf-ray": "8f00-SIN" }, body: { ticket, password } });

  it("refuses the computer's APP_SECRET password: the password must be set first", async () => {
    expect((await signIn(await ticketFor(), ADMIN.password)).status).toBe(403);
  });

  it("sets a password on the computer, then refuses a wrong one", async () => {
    const changed = await call("POST", "/api/auth/password", { body: { current: ADMIN.password, password: "tinyacrobatics1" }, cookie: adminCookie });
    expect(changed.status).toBe(200);
    expect((await signIn(await ticketFor(), "not-the-password")).status).toBe(401);
  });

  it("signs in with a ticket and the computer's password, once per browser", async () => {
    const res = await signIn(await ticketFor(), "tinyacrobatics1");
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    const check = (await (await call("GET", "/api/auth/check", { host: hostname, cookie })).json()) as { authed: boolean };
    expect(check.authed).toBe(true);
  });

  it("refuses a ticket a second time", async () => {
    const t = await ticketFor();
    expect((await signIn(t, "tinyacrobatics1")).status).toBe(200);
    expect((await signIn(t, "tinyacrobatics1")).status).toBe(401);
  });

  it("refuses a ticket for another account", async () => {
    const id = hostname.split(".")[0];
    const now = Math.floor(Date.now() / 1000);
    const other = issue({ sub: "acct-2", env: id, aud: hostname, iat: now, exp: now + 120, jti: "other-1" });
    expect((await signIn(other, "tinyacrobatics1")).status).toBe(401);
  });

  it("refuses an expired ticket and a ticket signed by another key", async () => {
    const id = hostname.split(".")[0];
    const now = Math.floor(Date.now() / 1000);
    const old = issue({ sub: "acct-1", env: id, aud: hostname, iat: now - 300, exp: now - 180, jti: "old-1" });
    expect((await signIn(old, "tinyacrobatics1")).status).toBe(401);
    const forged = generateKeyPairSync("ed25519").privateKey;
    const body = Buffer.from(JSON.stringify({ sub: "acct-1", env: id, aud: hostname, iat: now, exp: now + 120, jti: "forged-1" })).toString("base64url");
    const bad = `${body}.${sign(null, Buffer.from(body), forged).toString("base64url")}`;
    expect((await signIn(bad, "tinyacrobatics1")).status).toBe(401);
  });

  it("refuses a ticket sent to another name", async () => {
    const t = await ticketFor();
    const res = await call("POST", "/api/auth/ticket", { host: `other.${ZONE}`, body: { ticket: t, password: "tinyacrobatics1" } });
    expect(res.status).toBe(400);
  });
});

describe("with the sign-in code on, everything through the tunnel is asked for it", () => {
  it("a ticket and the password give a step token, never a cookie; the code then signs in; this Mac's window is not asked", async () => {
    vi.stubEnv("CT_LOCAL", "1");
    const { codeAt } = await import("../lib/sign-in-code");
    const { findUser, setSignInCode } = await import("../users");
    const secret = randomBytes(20);
    setSignInCode(findUser("admin")!, { secret: secret.toString("hex"), recovery: [], lastStep: 0 }, true);
    const viaTunnel = { "cf-connecting-ip": "203.0.113.9", "cf-ray": "8f00-SIN" };
    const id = hostname.split(".")[0];
    const r = await fakeBroker(new Request(`https://broker.test/v1/computers/${id}/ticket`, { method: "POST", headers: { authorization: `Bearer ${broker.lastToken}` } }));
    const { ticket } = (await r.json()) as { ticket: string };

    const res = await call("POST", "/api/auth/ticket", { host: hostname, headers: viaTunnel, body: { ticket, password: "tinyacrobatics1" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const { code, step } = (await res.json()) as { code: string; step: string };
    expect(code).toBe("CODE_NEEDED");
    const done = await call("POST", "/api/auth/code", { host: hostname, headers: viaTunnel, body: { step, code: codeAt(secret, Math.floor(Date.now() / 30_000)) } });
    expect(done.status).toBe(200);
    expect(((await (await call("GET", "/api/auth/check", { host: hostname, cookie: cookieOf(done) })).json()) as { authed: boolean }).authed).toBe(true);

    // addressed to the tunnel's name from loopback with no tunnel headers: asked too
    const named = await call("POST", "/api/auth/login", { host: hostname, body: { username: "admin", password: "tinyacrobatics1" } });
    expect(((await named.json()) as { code: string }).code).toBe("CODE_NEEDED");
    // this Mac's own window: signed in with the password alone
    expect((await call("POST", "/api/auth/login", { body: { username: "admin", password: "tinyacrobatics1" } })).status).toBe(200);
  });
});
