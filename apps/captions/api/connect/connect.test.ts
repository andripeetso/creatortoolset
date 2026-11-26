import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A computer on the connect broker, end to end against a fake broker that speaks the broker's protocol (the device
// grant, the link, the ticket). The "second machine" signs in through the tunnel hostname with a ticket.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "connect-"));
process.env.APP_SECRET = "local-sign-in-test-secret";
process.env.CT_CONNECT_URL = "https://broker.test";
// a link starts the tunnel at once (routes.ts /poll): a stand-in for cloudflared that only sleeps
const fakeTunnel = path.join(process.env.DATA_DIR, "cloudflared");
writeFileSync(fakeTunnel, "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
process.env.CT_CLOUDFLARED_PATH = fakeTunnel;

const app = (await import("../boot")).default;
const users = await import("../users");
const { computerKey } = await import("./keys");

const ZONE = "tunnels.test.example";
const relay = generateKeyPairSync("ed25519");
const relayB64 = relay.publicKey.export({ type: "spki", format: "der" }).toString("base64");

const broker = {
  approved: false,
  tokens: new Map<string, string>(), // access token -> account id
  nonces: new Map<string, string>(), // challenge -> account id
  computers: new Map<string, { sub: string; hostname: string }>(),
  lastToken: "",
  // the AI-app grants the computer sent, and a failure the next ones get (a status and a code, or "down": no answer)
  grants: [] as Array<{ app: string; key: string | null; pub: string; at: number }>,
  grantFail: null as null | "down" | { status: number; code: string },
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
  // the computer's own call, signed with its key and no account token: Install (a key) and Remove (null) for an AI app
  const grant = /^\/v1\/computers\/([0-9a-f]{32})\/ai-grant$/.exec(u.pathname);
  if (grant && req.method === "POST") {
    if (broker.grantFail === "down") throw new TypeError("fetch failed");
    if (broker.grantFail) return json(broker.grantFail.status, { error: broker.grantFail.code });
    const b = (await req.json()) as { public_key: string; payload: string; signature: string };
    const key = createPublicKey({ key: Buffer.from(b.public_key, "base64"), format: "der", type: "spki" });
    if (!verify(null, Buffer.from(b.payload), key, Buffer.from(b.signature, "base64"))) return json(401, { error: "bad_signature" });
    const p = JSON.parse(b.payload) as { purpose: string; computer_id: string; at: number; app: string; key: string | null };
    if (p.purpose !== "ai-grant" || p.computer_id !== grant[1]) return json(401, { error: "bad_signature" });
    broker.grants.push({ app: p.app, key: p.key, pub: b.public_key, at: p.at });
    return json(200, p.key === null ? { removed: false } : { ok: true });
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
  const started = await call("POST", "/api/connect/start", { cookie: adminCookie, body: {} });
  expect(started.status).toBe(200);
  expect(await started.json()).toMatchObject({ user_code: "BCDF-GHJK", verification_uri_complete: "https://broker.test/connect?code=BCDF-GHJK" });
  // still waiting for approval
  expect(await (await call("POST", "/api/connect/poll", { cookie: adminCookie, body: {} })).json()).toEqual({ status: "pending" });
  broker.approved = true;
  const polled = (await (await call("POST", "/api/connect/poll", { cookie: adminCookie, body: {} })).json()) as { status: string; hostname: string };
  expect(polled.status).toBe("linked");
  expect((await import("./connector")).connectorStatus().running).toBe(true); // the tunnel runs without a restart
  hostname = polled.hostname;
});

afterAll(async () => {
  await (await import("./connector")).stopConnector();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("a local server links to the broker", () => {
  it("records the tunnel hostname the broker made, and only the owner may link", async () => {
    const state = (await (await call("GET", "/api/connect", { cookie: adminCookie })).json()) as { linked: boolean; hostname: string };
    expect(state).toMatchObject({ linked: true, hostname });
    expect(hostname).toMatch(new RegExp(`^[0-9a-f]{32}\\.${ZONE.replace(/\./g, "\\.")}$`));
    expect((await call("GET", "/api/connect")).status).toBe(401);
    expect((await call("POST", "/api/connect/start", { cookie: adminCookie, body: {} })).status).toBe(409);
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

describe("with the sign-in code on, everything through the tunnel is asked for it", () => {
  it("the password gives a step token, never a cookie; the code then signs in; this Mac's window is not asked", async () => {
    vi.stubEnv("CT_LOCAL", "1");
    const { codeAt } = await import("../lib/sign-in-code");
    const { findUser, setSignInCode } = await import("../users");
    // the computer's own password first: while it is APP_SECRET, only this Mac signs in
    const changed = await call("POST", "/api/auth/password", { body: { current: ADMIN.password, password: "tinyacrobatics1" }, cookie: adminCookie });
    expect(changed.status).toBe(200);
    const secret = randomBytes(20);
    setSignInCode(findUser("admin")!, { secret: secret.toString("hex"), recovery: [], lastStep: 0 }, true);
    const viaTunnel = { "cf-connecting-ip": "203.0.113.9", "cf-ray": "8f00-SIN" };

    const res = await call("POST", "/api/auth/login", { host: hostname, headers: viaTunnel, body: { username: "admin", password: "tinyacrobatics1" } });
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

describe("through the tunnel, each client is its own address", () => {
  it("Cloudflare's CF-Connecting-IP: one client's wrong guesses lock that client only", { timeout: 30_000 }, async () => {
    vi.stubEnv("CT_LOCAL", "1");
    const from = (ip: string, password: string) =>
      call("POST", "/api/auth/login", { host: hostname, headers: { "cf-connecting-ip": ip, "cf-ray": "8f00-SIN" }, body: { username: "admin", password } });
    for (let i = 0; i < 5; i++) expect((await from("203.0.113.70", "not-the-password")).status).toBe(401);
    expect((await from("203.0.113.70", "tinyacrobatics1")).status).toBe(429);
    // another client through the tunnel gets the code step, as does the tunnel with no client named
    expect(((await (await from("203.0.113.71", "tinyacrobatics1")).json()) as { code: string }).code).toBe("CODE_NEEDED");
    const plain = await call("POST", "/api/auth/login", { host: hostname, body: { username: "admin", password: "tinyacrobatics1" } });
    expect(((await plain.json()) as { code: string }).code).toBe("CODE_NEEDED");
  });
});

describe("Install and Remove for ChatGPT and Claude, through the broker", () => {
  // the earlier tests changed the password, which ended the session the file began with: sign in again
  let owner = "";
  beforeAll(async () => {
    owner = cookieOf(await call("POST", "/api/auth/login", { body: { username: "admin", password: "tinyacrobatics1" } }));
    expect(owner).not.toBe("");
  });
  const post = (body: unknown, cookie = owner) => call("POST", "/api/connect/ai", { cookie, body });
  const claudeKeys = () => (users.findUser("admin")!.aiKeys ?? []).filter((k) => k.name === "Claude" && k.oauth);
  beforeEach(() => {
    broker.grants.length = 0;
    broker.grantFail = null;
  });

  it("Install makes the app's key and tells the broker, signed with this computer's key", async () => {
    const res = await post({ app: "Claude", on: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [g] = broker.grants;
    expect(g).toMatchObject({ app: "Claude", key: expect.stringMatching(/^ctk_[0-9a-f]{48}$/) });
    expect(g!.pub).toBe(computerKey().publicKey.export({ type: "spki", format: "der" }).toString("base64"));
    expect(Math.abs(g!.at - Date.now() / 1000)).toBeLessThan(60);
    expect(claudeKeys()).toHaveLength(1);
    expect(claudeKeys()[0]!.last4).toBe(g!.key!.slice(-4));
    // the address the rows show from now on is the broker's
    expect(((await (await call("GET", "/api/connect", { cookie: owner })).json()) as { ai: string }).ai).toBe("https://broker.test/mcp");
  });

  it("a GET asks the broker nothing: only a press does", async () => {
    await call("GET", "/api/connect", { cookie: owner });
    expect(broker.grants).toHaveLength(0);
  });

  it("refuses an app it does not know", async () => {
    expect((await post({ app: "Gemini", on: true })).status).toBe(400);
    expect(broker.grants).toHaveLength(0);
  });

  it("a broker without AI apps: says so, and the key just made is taken back", async () => {
    broker.grantFail = { status: 404, code: "not_found" };
    const res = await post({ app: "ChatGPT", on: true });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "The Connect service doesn't take AI apps yet." });
    expect((users.findUser("admin")!.aiKeys ?? []).some((k) => k.name === "ChatGPT")).toBe(false);
  });

  it("a computer the account no longer has: says to link it again, and takes the key back", async () => {
    broker.grantFail = { status: 404, code: "unknown_computer" };
    const res = await post({ app: "ChatGPT", on: true });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/Link it again/);
    expect((users.findUser("admin")!.aiKeys ?? []).some((k) => k.name === "ChatGPT")).toBe(false);
  });

  it("a broker that can't be reached: says so, and the key just made is taken back", async () => {
    broker.grantFail = "down";
    const res = await post({ app: "Claude", on: true });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/couldn't take it right now/);
    expect(claudeKeys()).toHaveLength(0);
  });

  it("Remove takes the app's key back here and tells the broker null", async () => {
    await post({ app: "Claude", on: true });
    broker.grants.length = 0;
    const res = await post({ app: "Claude", on: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(claudeKeys()).toHaveLength(0);
    expect(broker.grants).toEqual([expect.objectContaining({ app: "Claude", key: null })]);
  });

  it("Remove still works here when the broker can't be reached", async () => {
    await post({ app: "Claude", on: true });
    broker.grantFail = "down";
    const res = await post({ app: "Claude", on: false });
    expect(res.status).toBe(200);
    expect(claudeKeys()).toHaveLength(0);
  });

  it("refuses a person who is not the owner, and asks the broker nothing", async () => {
    users.createUser("member", "tinyacrobatics1", { role: "user" });
    const memberCookie = cookieOf(await call("POST", "/api/auth/login", { body: { username: "member", password: "tinyacrobatics1" } }));
    expect(memberCookie).not.toBe("");
    expect((await post({ app: "Claude", on: true }, memberCookie)).status).toBe(403);
    expect(broker.grants).toHaveLength(0);
  });
});

describe("a computer that is not linked", () => {
  it("refuses Install in plain words, and asks the broker nothing", async () => {
    const { saveConnectState } = await import("./state");
    saveConnectState(null);
    const cookie = cookieOf(await call("POST", "/api/auth/login", { body: { username: "admin", password: "tinyacrobatics1" } }));
    const res = await call("POST", "/api/connect/ai", { cookie, body: { app: "ChatGPT", on: true } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "This computer isn't linked to your account yet" });
    expect(broker.grants).toHaveLength(0);
    expect(((await (await call("GET", "/api/connect", { cookie })).json()) as { ai: unknown }).ai).toBeNull();
  });
});
