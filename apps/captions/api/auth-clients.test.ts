import { generateKeyPairSync, randomUUID, sign, createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// A phone pairs with a server on someone's own computer whose password is still the app's secret: no password is
// asked anywhere, the session is the server's own, and revoking it ends the phone's change stream at once.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "auth-clients-"));
process.env.APP_SECRET = "local-sign-in-test-secret";
process.env.CT_LOCAL = "1";

const app = (await import("./boot")).default;
const { MAX_JTIS_PER_KEY, dpopReplayForTest, jwkThumbprint } = await import("./lib/dpop");

type Opts = { address?: string; headers?: Record<string, string>; body?: unknown; form?: Record<string, string>; cookie?: string; token?: string };
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
  const address = o.address ?? "127.0.0.1";
  return app.request(`http://localhost${p}`, { method, headers, body }, { incoming: { socket: { remoteAddress: address, remotePort: 50000, remoteFamily: "IPv4" } } });
}

const PHONE = "10.0.0.20";
const exchange = (credential: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  call("POST", "/oauth/token", {
    address: PHONE,
    headers,
    form: {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:creatortoolset:params:oauth:token-type:server-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_device_type: "mobile",
      client_os: "iOS 26",
      client_label: "Sam's iPhone",
      ...extra,
    },
  });

let cookie = "";
const newLink = async (body: unknown = {}) => {
  const r = await call("POST", "/api/auth/pairing-links", { cookie, body });
  expect(r.status).toBe(200);
  return (await r.json()) as { id: string; credential: string; urls: Array<{ kind: string; url: string }>; scopes: string[]; label?: string };
};
const pairBearer = async (body: unknown = {}) => {
  const link = await newLink(body);
  const r = await exchange(link.credential);
  expect(r.status).toBe(200);
  return (await r.json()) as { access_token: string; token_type: string; expires_in: number; scope: string };
};

// a phone's P-256 key and its proofs
const phoneKey = (() => {
  const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j = k.publicKey.export({ format: "jwk" }) as Record<string, string>;
  return { privateKey: k.privateKey, jwk: { kty: j.kty, crv: j.crv, x: j.x, y: j.y } };
})();
function dpop(htm: string, htu: string, token?: string) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = b64({ typ: "dpop+jwt", alg: "ES256", jwk: phoneKey.jwk });
  const p = b64({ htm, htu, iat: Math.floor(Date.now() / 1000), jti: randomUUID(), ...(token ? { ath: createHash("sha256").update(token).digest("base64url") } : {}) });
  return `${h}.${p}.${sign("sha256", Buffer.from(`${h}.${p}`), { key: phoneKey.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

/** Reads an SSE body until `want` shows up (or fails after 3 s); returns what it read. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, want: string): Promise<string> {
  let text = "";
  const deadline = Date.now() + 3000;
  while (!text.includes(want)) {
    const r = await Promise.race([reader.read(), new Promise<never>((_, no) => setTimeout(() => no(new Error(`no "${want}" in: ${text}`)), Math.max(1, deadline - Date.now())))]);
    if (r.done) throw new Error(`stream ended before "${want}": ${text}`);
    text += new TextDecoder().decode(r.value);
  }
  return text;
}
const endsSoon = (reader: ReadableStreamDefaultReader<Uint8Array>) =>
  Promise.race([
    (async () => {
      for (;;) if ((await reader.read()).done) return "ended";
    })(),
    new Promise<string>((ok) => setTimeout(() => ok("still open"), 3000)),
  ]);

/** A browser's sign-in: its cookie. */
const signIn = async () => {
  const r = await call("POST", "/api/auth/login", { body: { username: "admin", password: process.env.APP_SECRET } });
  expect(r.status).toBe(200);
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
};
beforeAll(async () => {
  cookie = await signIn();
});

describe("pairing links", () => {
  it("are made with no computer password, carry no loopback address and need a sign-in", async () => {
    const link = await newLink({ label: "Living room iPad", scopes: ["read"] });
    expect(link.credential).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/);
    expect(link.scopes).toEqual(["read"]);
    for (const u of link.urls) {
      expect(u.url).toMatch(/\/#token=[A-Z2-9]{12}$/);
      expect(u.url).not.toMatch(/\/\/(localhost|127\.)/);
    }
    expect((await call("POST", "/api/auth/pairing-links", { body: {} })).status).toBe(401);
    expect((await call("POST", "/api/auth/pairing-links", { cookie, body: { scopes: ["admin"] } })).status).toBe(400);
  });

  it("are listed without their code, and revoked", async () => {
    const link = await newLink();
    const list = await (await call("GET", "/api/auth/access", { cookie })).text();
    expect(list).toContain(link.id);
    expect(list).not.toContain(link.credential);
    expect((await call("POST", "/api/auth/pairing-links/revoke", { cookie, body: { id: link.id } })).status).toBe(200);
    expect(await (await exchange(link.credential)).json()).toMatchObject({ error: "invalid_grant" });
  });
});

describe("the token exchange", () => {
  it("gives a 30-day Bearer session that signs in as the link's maker, once", async () => {
    const link = await newLink({ label: "Living room iPad", deviceType: "tablet" });
    const r = await exchange(link.credential.toLowerCase());
    expect(r.headers.get("cache-control")).toBe("no-store");
    const t = (await r.json()) as { access_token: string; token_type: string; expires_in: number; scope: string };
    expect(t).toMatchObject({ token_type: "Bearer", scope: "read write access" });
    expect(t.expires_in).toBeGreaterThan(30 * 24 * 3600 - 60);
    expect(await (await exchange(link.credential)).json()).toMatchObject({ error: "invalid_grant" });
    const s = await (await call("GET", "/api/auth/session", { address: PHONE, token: t.access_token })).json();
    expect(s).toMatchObject({ authenticated: true, method: "bearer-access-token", scopes: ["read", "write", "access"], user: { username: "admin" } });
    // the link's name and kind win over what the device sent; its own details are kept
    const list = (await (await call("GET", "/api/auth/access", { cookie })).json()) as { clientSessions: Array<{ label?: string; client: { os?: string; deviceType: string; ipAddress?: string } }> };
    expect(list.clientSessions.find((x) => x.label === "Living room iPad")?.client).toMatchObject({ os: "iOS 26", deviceType: "tablet", ipAddress: PHONE });
    // a link made without a kind is for an unknown device, though the device says phone; a kind it doesn't know is refused
    const plain = await newLink({ label: "Another device" });
    expect((await exchange(plain.credential)).status).toBe(200);
    const after = (await (await call("GET", "/api/auth/access", { cookie })).json()) as typeof list;
    expect(after.clientSessions.find((x) => x.label === "Another device")?.client.deviceType).toBe("unknown");
    expect((await call("POST", "/api/auth/pairing-links", { cookie, body: { deviceType: "phone" } })).status).toBe(400);
  });

  it("refuses scopes the link doesn't hold without spending it", async () => {
    const link = await newLink({ scopes: ["read"] });
    expect(await (await exchange(link.credential, { scope: "write" })).json()).toMatchObject({ error: "invalid_scope" });
    expect(await (await exchange(link.credential, { scope: "read write" })).json()).toMatchObject({ scope: "read" });
  });

  it("refuses a wrong grant type and wrong token types", async () => {
    const link = await newLink();
    expect(await (await exchange(link.credential, { grant_type: "authorization_code" })).json()).toMatchObject({ error: "unsupported_grant_type" });
    expect(await (await exchange(link.credential, { subject_token_type: "x" })).json()).toMatchObject({ error: "invalid_request" });
  });

  it("binds the session to the phone's key with a DPoP proof, and a bad proof fails without spending the code", async () => {
    const link = await newLink();
    const bad = await exchange(link.credential, {}, { dpop: dpop("POST", "http://localhost/elsewhere") });
    expect(await bad.json()).toMatchObject({ error: "invalid_dpop_proof" });
    const r = await exchange(link.credential, {}, { dpop: dpop("POST", "http://localhost/oauth/token") });
    const t = (await r.json()) as { access_token: string; token_type: string; expires_in: number };
    expect(t.token_type).toBe("DPoP");
    expect(t.expires_in).toBeLessThanOrEqual(3600);
    const url = "http://localhost/api/auth/session";
    const proof = dpop("GET", url, t.access_token);
    const ok = await call("GET", "/api/auth/session", { address: PHONE, headers: { authorization: `DPoP ${t.access_token}`, dpop: proof } });
    expect(await ok.json()).toMatchObject({ authenticated: true, method: "dpop-access-token" });
    // the same proof again, the token as Bearer, and no proof: all refused
    expect((await call("GET", "/api/auth/session", { address: PHONE, headers: { authorization: `DPoP ${t.access_token}`, dpop: proof } })).status).toBe(401);
    const asBearer = await call("GET", "/api/auth/session", { address: PHONE, token: t.access_token });
    expect(await asBearer.json()).toMatchObject({ code: "INVALID_DPOP" });
    expect((await call("GET", "/api/auth/session", { address: PHONE, headers: { authorization: `DPoP ${t.access_token}` } })).status).toBe(401);
  });

  it("keeps a proof's jti unspent when the code fails, so anyone posting proofs here spends nothing", async () => {
    const proof = dpop("POST", "http://localhost/oauth/token");
    expect(await (await exchange("ZZZZZZZZZZZZ", {}, { dpop: proof })).json()).toMatchObject({ error: "invalid_grant" });
    const link = await newLink();
    const r = await exchange(link.credential, {}, { dpop: proof });
    expect(await r.json()).toMatchObject({ token_type: "DPoP" });
    // once a code went through with it, the proof is spent
    expect(await (await exchange((await newLink()).credential, {}, { dpop: proof })).json()).toMatchObject({ error: "invalid_dpop_proof" });
  });
});

describe("a session on /api", () => {
  it("is checked before the cookie and never falls back to it", async () => {
    const r = await call("GET", "/api/nothing-here", { cookie, token: "cts_" + "A".repeat(43) });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(await r.json()).toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("Read only looks but doesn't change or manage access", async () => {
    const t = await pairBearer({ scopes: ["read"] });
    expect((await call("GET", "/api/nothing-here", { address: PHONE, token: t.access_token })).status).toBe(404); // past the gate
    const w = await call("POST", "/api/nothing-here", { address: PHONE, token: t.access_token, body: {} });
    expect(w.status).toBe(403);
    expect(await w.json()).toMatchObject({ code: "SCOPE", requiredScope: "write" });
    expect(await (await call("GET", "/api/auth/access", { address: PHONE, token: t.access_token })).json()).toMatchObject({ code: "SCOPE", requiredScope: "access" });
    expect(await (await call("POST", "/api/auth/pairing-links", { address: PHONE, token: t.access_token, body: {} })).json()).toMatchObject({ code: "SCOPE" });
  });

  it("a Standard session can't hand on more than it holds, but can make a Read only link", async () => {
    const t = await pairBearer();
    const r = await call("POST", "/api/auth/pairing-links", { address: PHONE, token: t.access_token, body: { scopes: ["read"] } });
    expect(r.status).toBe(200);
  });

  it("is connected while its change stream is open, and a revoke ends that stream at once", async () => {
    const t = await pairBearer();
    const res = await call("GET", "/api/sync/events", { address: PHONE, token: t.access_token });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await readUntil(reader, "event: hello");
    const list = (await (await call("GET", "/api/auth/access", { cookie })).json()) as { clientSessions: Array<{ sessionId: string; connected: boolean; lastConnectedAt: string | null }> };
    const mine = list.clientSessions.filter((s) => s.connected);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.lastConnectedAt).not.toBeNull();
    expect((await call("POST", "/api/auth/clients/revoke", { cookie, body: { sessionId: mine[0]!.sessionId } })).status).toBe(200);
    expect(await endsSoon(reader)).toBe("ended");
    expect(await (await call("GET", "/api/auth/session", { address: PHONE, token: t.access_token })).json()).toMatchObject({ code: "SESSION_REVOKED" });
  });

  it("never reaches this computer's connect settings, whatever its scopes", async () => {
    const t = await pairBearer();
    for (const [method, p] of [["GET", "/api/connect"], ["POST", "/api/connect/ai"], ["POST", "/api/connect/relay-config"], ["GET", "/api/connect/notifications"]]) {
      const r = await call(method, p, { address: PHONE, token: t.access_token, body: method === "POST" ? {} : undefined });
      expect({ p, status: r.status }).toEqual({ p, status: 403 });
      expect(await r.json()).toMatchObject({ code: "NOT_FOR_CLIENTS" });
    }
    // the app's connectors are a different route
    expect(await (await call("GET", "/api/connectors", { address: PHONE, token: t.access_token })).json()).not.toMatchObject({ code: "NOT_FOR_CLIENTS" });
  });

  it("answers 503 BUSY, never a signature error, while its key has spent its share of proofs", async () => {
    const link = await newLink();
    const t = (await (await exchange(link.credential, {}, { dpop: dpop("POST", "http://localhost/oauth/token") })).json()) as { access_token: string };
    const url = "http://localhost/api/auth/session";
    const seen = dpopReplayForTest();
    const jkt = jwkThumbprint(phoneKey.jwk as never);
    const before = seen.get(jkt);
    seen.set(jkt, new Map(Array.from({ length: MAX_JTIS_PER_KEY }, (_, i) => [`flood${i}`, Date.now() / 1000 + 600])));
    try {
      const r = await call("GET", "/api/auth/session", { address: PHONE, headers: { authorization: `DPoP ${t.access_token}`, dpop: dpop("GET", url, t.access_token) } });
      expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).toBe("60");
      expect(await r.json()).toMatchObject({ code: "BUSY" });
    } finally {
      if (before) seen.set(jkt, before);
      else seen.delete(jkt);
    }
    const ok = await call("GET", "/api/auth/session", { address: PHONE, headers: { authorization: `DPoP ${t.access_token}`, dpop: dpop("GET", url, t.access_token) } });
    expect(ok.status).toBe(200);
  });

  it("has its access line closed when the session runs out", async () => {
    const { issueSession, BEARER_TTL_MS } = await import("./lib/clients");
    const { token } = issueSession({ subject: "admin", scopes: ["read", "write", "access"], client: { deviceType: "mobile" }, now: Date.now() - BEARER_TTL_MS + 1000 });
    const res = await call("GET", "/api/auth/access/events", { address: PHONE, token });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await readUntil(reader, "event: snapshot");
    expect(await endsSoon(reader)).toBe("ended");
  });

  it("revoke-others keeps the caller's own session", async () => {
    const a = await pairBearer();
    const b = await pairBearer();
    const r = await call("POST", "/api/auth/clients/revoke-others", { address: PHONE, token: a.access_token });
    expect(await r.json()).toMatchObject({ ok: true });
    expect((await call("GET", "/api/auth/session", { address: PHONE, token: a.access_token })).status).toBe(200);
    expect((await call("GET", "/api/auth/session", { address: PHONE, token: b.access_token })).status).toBe(401);
    // a browser's sign-in is one of the others
    expect((await call("GET", "/api/auth/access", { cookie })).status).toBe(401);
    cookie = await signIn();
  });
});

describe("revoke-others is the caller's own account", () => {
  it("an admin's press leaves the team signed in; a member's sign-in still ends by its own revoke", async () => {
    const { createUser } = await import("./users");
    createUser("tiny-member", "a-long-password-9");
    const signedIn = await call("POST", "/api/auth/login", { body: { username: "tiny-member", password: "a-long-password-9" } });
    const member = (signedIn.headers.get("set-cookie") ?? "").split(";")[0]!;
    const mine = await signIn();
    expect((await call("POST", "/api/auth/clients/revoke-others", { cookie, body: {} })).status).toBe(200);
    // the admin's other sign-in went, the member's did not
    expect((await call("GET", "/api/auth/access", { cookie: mine })).status).toBe(401);
    expect((await call("GET", "/api/auth/access", { cookie: member })).status).toBe(200);
    const theirs = ((await (await call("GET", "/api/auth/access", { cookie: member })).json()) as { clientSessions: Array<{ sessionId: string; current: boolean }> }).clientSessions.find((x) => x.current)!;
    expect((await call("POST", "/api/auth/clients/revoke", { cookie, body: { sessionId: theirs.sessionId } })).status).toBe(200);
    expect((await call("GET", "/api/auth/access", { cookie: member })).status).toBe(401);
  });
});

describe("a sign-in is a session like a paired device's", () => {
  type Listed = { clientSessions: Array<{ sessionId: string; method: string; current: boolean }> };
  const listed = async (as: string) => ((await (await call("GET", "/api/auth/access", { cookie: as })).json()) as Listed).clientSessions;

  it("is listed, with the browser that asks marked as this one", async () => {
    const other = await signIn();
    const rows = (await listed(cookie)).filter((s) => s.method === "browser-cookie");
    expect(rows.filter((s) => s.current)).toHaveLength(1);
    expect(rows.filter((s) => !s.current).length).toBeGreaterThanOrEqual(1);
    expect((await listed(other)).filter((s) => s.current)).toHaveLength(1);
  });

  it("is revoked by itself: its cookie opens nothing, the others stay", async () => {
    const other = await signIn();
    const its = (await listed(other)).find((s) => s.current)!;
    const r = await call("POST", "/api/auth/clients/revoke", { cookie, body: { sessionId: its.sessionId } });
    expect(r.status).toBe(200);
    expect((await call("GET", "/api/auth/access", { cookie: other })).status).toBe(401);
    expect(((await (await call("GET", "/api/auth/check", { cookie: other })).json()) as { authed: boolean }).authed).toBe(false);
    expect((await call("GET", "/api/auth/access", { cookie })).status).toBe(200);
  });

  it("signing out ends that browser's sign-in only", async () => {
    const other = await signIn();
    expect((await call("POST", "/api/auth/logout", { cookie: other })).status).toBe(200);
    expect((await call("GET", "/api/auth/access", { cookie: other })).status).toBe(401);
    expect((await call("GET", "/api/auth/access", { cookie })).status).toBe(200);
  });

  it("signing in again in one browser replaces its sign-in, never adds a second row", async () => {
    const first = await signIn();
    const before = (await listed(cookie)).length;
    const r = await call("POST", "/api/auth/login", { cookie: first, body: { username: "admin", password: process.env.APP_SECRET } });
    expect(r.status).toBe(200);
    expect((await listed(cookie)).length).toBe(before);
    expect((await call("GET", "/api/auth/access", { cookie: first })).status).toBe(401);
  });

  it("a paired device's token in the cookie is no sign-in, and a sign-in's token is no device's", async () => {
    // read-only device: in the cookie it would be the whole account
    const link = await newLink({ scopes: ["read"] });
    const t = (await (await exchange(link.credential)).json()) as { access_token: string };
    expect((await call("GET", "/api/auth/access", { cookie: `cap_auth=${t.access_token}` })).status).toBe(401);
    expect(((await (await call("GET", "/api/auth/check", { cookie: `cap_auth=${t.access_token}` })).json()) as { authed: boolean }).authed).toBe(false);
    const r = await call("GET", "/api/auth/session", { token: cookie.slice("cap_auth=".length) });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("the server's own login for a call as an account works and is never listed", async () => {
    const { ownLogin } = await import("./auth");
    const { findUser } = await import("./users");
    const before = (await listed(cookie)).length;
    const token = ownLogin(findUser("admin")!);
    expect(ownLogin(findUser("admin")!)).toBe(token); // kept while it lasts
    expect(((await (await call("GET", "/api/auth/check", { cookie: `cap_auth=${token}` })).json()) as { authed: boolean }).authed).toBe(true);
    expect((await listed(cookie)).length).toBe(before);
  });
});

describe("the live access list", () => {
  it("starts with a snapshot and sends each new link and session", async () => {
    const res = await call("GET", "/api/auth/access/events", { cookie });
    const reader = res.body!.getReader();
    await readUntil(reader, "event: snapshot");
    const link = await newLink({ label: "Kitchen iPad" });
    await readUntil(reader, link.id);
    await exchange(link.credential);
    const text = await readUntil(reader, "event: clientUpserted");
    expect(text).toContain("event: pairingLinkRemoved");
    expect(text).not.toContain(link.credential);
    await reader.cancel();
  });
});
