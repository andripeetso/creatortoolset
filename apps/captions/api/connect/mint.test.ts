import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The connect service asks a linked computer, through its tunnel, whether it is up and for a one-time code bound to a
// phone's key. Every request is a short proof by the pinned broker key; every answer is signed by the computer.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "connect-mint-"));
process.env.APP_SECRET = "local-sign-in-test-secret";
const fakeTunnel = path.join(process.env.DATA_DIR, "cloudflared");
writeFileSync(fakeTunnel, "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
process.env.CT_CLOUDFLARED_PATH = fakeTunnel;

const app = (await import("../boot")).default;
const { computerKey, verifyJws } = await import("./keys");
const { connectState } = await import("./state");

const BROKER = "https://broker.test";
const OWNER = "acct-1";
const broker = generateKeyPairSync("ed25519");
const brokerB64 = broker.publicKey.export({ type: "spki", format: "der" }).toString("base64");
let id = "";
let host = "";
let cookie = "";

function call(method: string, p: string, o: { host?: string; headers?: Record<string, string>; body?: unknown; form?: Record<string, string>; cookie?: string } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  let body: string | undefined;
  if (o.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(o.form).toString();
  } else if (o.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.body);
  }
  const url = o.host ? `https://${o.host}${p}` : `http://localhost${p}`;
  return app.request(url, { method, headers, body }, { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50000, remoteFamily: "IPv4" } } });
}

const jws = (typ: string, payload: object, key = broker.privateKey) => {
  const h = Buffer.from(JSON.stringify({ alg: "EdDSA", typ })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
};
const now = () => Math.floor(Date.now() / 1000);
const claims = (scope: string, extra: Record<string, unknown> = {}) => ({ iss: BROKER, aud: `ct-computer:${id}`, sub: OWNER, jti: randomUUID(), iat: now(), exp: now() + 120, nonce: randomUUID(), scope: [scope], ...extra });
const health = (payload: object, o: { headers?: Record<string, string>; host?: string; typ?: string } = {}) =>
  call("POST", "/api/connect/health", { host: o.host ?? host, headers: o.headers, body: { proof: jws(o.typ ?? "ct-connect-health+jwt", payload) } });

// the phone's P-256 key
const phone = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pj = phone.publicKey.export({ format: "jwk" }) as Record<string, string>;
const jwk = { kty: pj.kty, crv: pj.crv, x: pj.x, y: pj.y };
const jkt = createHash("sha256").update(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`).digest("base64url");
const mintClaims = (extra: Record<string, unknown> = {}) => claims("connect", { clientProofKeyThumbprint: jkt, cnf: { jkt }, ...extra });
const mint = (payload: object) => call("POST", "/api/connect/mint", { host, body: { proof: jws("ct-connect-mint+jwt", payload) } });
function dpop(htu: string) {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = b({ typ: "dpop+jwt", alg: "ES256", jwk });
  const p = b({ htm: "POST", htu, iat: now(), jti: randomUUID() });
  return `${h}.${p}.${sign("sha256", Buffer.from(`${h}.${p}`), { key: phone.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

beforeAll(async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  const r = await call("POST", "/api/auth/login", { body: { username: "admin", password: process.env.APP_SECRET } });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  id = computerKey().id;
  host = `${id}.tunnels.test.example`;
});

afterAll(async () => {
  await (await import("./connector")).stopConnector();
  vi.unstubAllGlobals();
});

describe("linking with the Mac app's own sign-in", () => {
  it("signs a link proof only for a request made on this computer", async () => {
    const r = await call("POST", "/api/connect/link-proof", { cookie, body: { challenge: "c-1", relayUrl: `${BROKER}/v1` } });
    expect(r.status).toBe(200);
    const a = (await r.json()) as { proof: string; computerId: string; publicKey: string; origin: string };
    expect(a.computerId).toBe(id);
    const key = createPublicKey({ key: Buffer.from(a.publicKey, "base64"), format: "der", type: "spki" });
    expect(verifyJws(a.proof, "ct-link-proof+jwt", key)).toMatchObject({ iss: `ct-computer:${id}`, aud: BROKER, sub: id, challenge: "c-1", origin: a.origin });
    expect((await call("POST", "/api/connect/link-proof", { cookie, headers: { "x-forwarded-host": "evil.example" }, body: { challenge: "c", relayUrl: BROKER } })).status).toBe(403);
    expect((await call("POST", "/api/connect/link-proof", { cookie, headers: { "x-forwarded-proto": "https" }, body: { challenge: "c", relayUrl: BROKER } })).status).toBe(403);
    expect((await call("POST", "/api/connect/link-proof", { body: { challenge: "c", relayUrl: BROKER } })).status).toBe(401);
  });

  it("stores the service's answer and refuses one made for another computer", async () => {
    const body = { brokerUrl: BROKER, owner: OWNER, computerId: id, hostname: host, tunnelToken: "tunnel-token", brokerKey: brokerB64 };
    expect((await call("POST", "/api/connect/relay-config", { cookie, body: { ...body, computerId: "0".repeat(32) } })).status).toBe(400);
    expect((await call("POST", "/api/connect/relay-config", { cookie, body: { ...body, brokerKey: Buffer.from("not a key").toString("base64") } })).status).toBe(400);
    const r = await call("POST", "/api/connect/relay-config", { cookie, body });
    expect(await r.json()).toEqual({ ok: true, hostname: host });
    expect(connectState()).toMatchObject({ owner: OWNER, localUser: "admin", hostname: host, relayPublicKey: brokerB64 });
  });
});

describe("health", () => {
  it("answers a good proof with a signed answer bound to its nonce", async () => {
    const p = claims("status");
    const r = await health(p);
    expect(r.status).toBe(200);
    const a = (await r.json()) as { serverId: string; status: string; descriptor: { serverId: string }; proof: string };
    expect(a).toMatchObject({ serverId: id, status: "online", descriptor: { serverId: id } });
    expect(verifyJws(a.proof, "ct-connect-health-answer+jwt", computerKey().publicKey)).toMatchObject({ requestNonce: p.nonce, aud: BROKER, sub: id, status: "online" });
  });

  it("refuses a wrong audience, account, scope, issuer, type, key or lifetime", async () => {
    const other = generateKeyPairSync("ed25519");
    const bad = [
      claims("status", { aud: "ct-computer:someone-else" }),
      claims("status", { sub: "acct-2" }),
      claims("connect"),
      claims("status", { scope: ["status", "connect"] }),
      claims("status", { iss: "https://other.example" }),
      claims("status", { exp: now() + 301, iat: now() }),
      claims("status", { iat: now() + 120, exp: now() + 200 }),
      claims("status", { iat: now() - 200, exp: now() - 1 }),
    ];
    for (const p of bad) expect(await (await health(p)).json()).toEqual({ error: "proof_rejected" });
    expect(await (await health(claims("status"), { typ: "ct-connect-mint+jwt" })).json()).toEqual({ error: "proof_rejected" });
    const forged = call("POST", "/api/connect/health", { host, body: { proof: jws("ct-connect-health+jwt", claims("status"), other.privateKey) } });
    expect((await forged).status).toBe(401);
  });

  it("uses each jti and each nonce once", async () => {
    const p = claims("status");
    expect((await health(p)).status).toBe(200);
    expect(await (await health(p)).json()).toEqual({ error: "proof_replayed" });
    expect((await health({ ...p, jti: randomUUID() })).status).toBe(409); // the nonce again under a new jti
  });

  it("answers only on the tunnel hostname, and never with a forwarded host", async () => {
    expect((await health(claims("status"), { headers: { "x-forwarded-host": host } })).status).toBe(421);
    expect((await call("POST", "/api/connect/health", { body: { proof: jws("ct-connect-health+jwt", claims("status")) } })).status).toBe(421);
  });
});

describe("mint", () => {
  it("makes a 2-minute code bound to the phone's key, redeemed only with that key's proof, as Standard", async () => {
    const p = mintClaims();
    const r = await mint(p);
    expect(r.status).toBe(200);
    const a = (await r.json()) as { credential: string; expiresAt: string; proof: string };
    expect(a.credential).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/);
    expect(Date.parse(a.expiresAt) - Date.now()).toBeLessThanOrEqual(120_000);
    expect(verifyJws(a.proof, "ct-connect-mint-answer+jwt", computerKey().publicKey)).toMatchObject({ requestNonce: p.nonce, clientProofKeyThumbprint: jkt, credential: a.credential });

    const form = {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: a.credential,
      subject_token_type: "urn:creatortoolset:params:oauth:token-type:server-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_device_type: "mobile",
    };
    const url = `https://${host}/oauth/token`;
    // no proof (a Bearer ask) and a proof by another key: refused, the code kept
    expect(await (await call("POST", "/oauth/token", { host, form })).json()).toMatchObject({ error: "invalid_grant" });
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const oj = other.publicKey.export({ format: "jwk" }) as Record<string, string>;
    const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const h = b({ typ: "dpop+jwt", alg: "ES256", jwk: { kty: oj.kty, crv: oj.crv, x: oj.x, y: oj.y } });
    const pl = b({ htm: "POST", htu: url, iat: now(), jti: randomUUID() });
    const otherProof = `${h}.${pl}.${sign("sha256", Buffer.from(`${h}.${pl}`), { key: other.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    expect(await (await call("POST", "/oauth/token", { host, form, headers: { dpop: otherProof } })).json()).toMatchObject({ error: "invalid_grant" });
    const t = (await (await call("POST", "/oauth/token", { host, form, headers: { dpop: dpop(url) } })).json()) as { token_type: string; scope: string };
    expect(t).toMatchObject({ token_type: "DPoP", scope: "read write access" });
  });

  it("refuses a proof whose cnf.jkt isn't the phone's key, a wrong scope, and a replay", async () => {
    expect(await (await mint(mintClaims({ cnf: { jkt: "x".repeat(43) } }))).json()).toEqual({ error: "proof_rejected" });
    expect(await (await mint(mintClaims({ scope: ["status"] }))).json()).toEqual({ error: "proof_rejected" });
    expect(await (await mint(mintClaims({ sub: "acct-2" }))).json()).toEqual({ error: "proof_rejected" });
    const p = mintClaims();
    expect((await mint(p)).status).toBe(200);
    expect((await mint(p)).status).toBe(409);
  });
});

describe("unlinking", () => {
  it("forgets the link, after which the service's requests find nothing", async () => {
    expect((await call("DELETE", "/api/connect/relay-config", { cookie })).status).toBe(200);
    expect(connectState()).toBeNull();
    expect(await (await health(claims("status"))).json()).toEqual({ error: "not_linked" });
  });
});
