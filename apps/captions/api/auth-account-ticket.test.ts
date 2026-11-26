import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// A phone signed in to its account at the sign-in service gets into a hosted server that names that service with no
// second sign-in: an account ticket at /oauth/token, bound to the phone's key and this server's host (sign-in.ts
// accountTicketUser).
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "account-ticket-"));
process.env.APP_SECRET = "account-ticket-secret";
process.env.CT_MODE = "hosted";
process.env.PUBLIC_ORIGIN = "https://studio.test.example";
for (const k of ["APPLE_SIGNIN_KEY", "GOOGLE_SIGNIN_CLIENT_ID", "GOOGLE_SIGNIN_CLIENT_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "ACCOUNT_SIGNIN_SERVICE", "SIGN_UPS"]) delete process.env[k];

const app = (await import("./boot")).default;
const { createUser, linkIdentity } = await import("./users");
const { ticketTries, perMinute } = await import("./auth-clients");

const SERVICE = "https://signin.test";
const HOST = "studio.test.example";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const phone = (() => {
  const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j = k.publicKey.export({ format: "jwk" }) as Record<string, string>;
  const jwk = { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
  const jkt = createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url");
  return { privateKey: k.privateKey, jwk, jkt };
})();
function dpop(htm: string, htu: string, token?: string) {
  const h = b64({ typ: "dpop+jwt", alg: "ES256", jwk: phone.jwk });
  const p = b64({ htm, htu, iat: Math.floor(Date.now() / 1000), jti: randomUUID(), ...(token ? { ath: createHash("sha256").update(token).digest("base64url") } : {}) });
  return `${h}.${p}.${sign("sha256", Buffer.from(`${h}.${p}`), { key: phone.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

const VERIFIER = "v".repeat(43);
/** The service's redeem, faked: pays out `who` for ticket T1 and the phone's verifier; records what was asked. */
function service(who: Record<string, unknown>) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    asked.push(String(url));
    const { ticket, verifier } = JSON.parse(String(init?.body)) as { ticket: string; verifier: string };
    return ticket === "T1" && verifier === VERIFIER ? Response.json(who) : Response.json({ error: "That sign-in expired: start it again" }, { status: 410 });
  });
  return asked;
}

function exchange(o: { ticket?: string; verifier?: string; bound?: boolean; scope?: string } = {}) {
  const form: Record<string, string> = {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: o.ticket ?? "T1",
    subject_token_type: "urn:creatortoolset:params:oauth:token-type:account-ticket",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_device_type: "mobile",
    ...(o.verifier === "" ? {} : { code_verifier: o.verifier ?? VERIFIER }),
    ...(o.scope ? { scope: o.scope } : {}),
  };
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (o.bound !== false) headers.dpop = dpop("POST", "http://localhost/oauth/token");
  return app.request("http://localhost/oauth/token", { method: "POST", headers, body: new URLSearchParams(form).toString() });
}
const ticketFor = (who: { provider: string; sub: string }, more: Record<string, unknown> = {}) => ({ ...who, email: "", name: "", jkt: phone.jkt, host: HOST, ...more });

beforeAll(() => {
  linkIdentity(createUser("tiny-sam", "a-long-password-1"), { provider: "google", sub: "g-sam", email: "sam@tinyacrobatics.com", name: "Sam" });
  linkIdentity(createUser("tiny-alex", "a-long-password-2"), { provider: "apple", sub: "a-alex", email: "", name: "" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ACCOUNT_SIGNIN_SERVICE;
  process.env.PUBLIC_ORIGIN = "https://studio.test.example";
  ticketTries.clear();
});

describe("with the sign-in service named", () => {
  it("says so in its descriptor", async () => {
    const account = async () => ((await (await app.request("/.well-known/creator-toolset/server")).json()) as { capabilities: { account: boolean } }).capabilities.account;
    expect(await account()).toBe(false);
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    expect(await account()).toBe(true);
    // with no address of its own it would take the request's Host for its own: no tickets then
    delete process.env.PUBLIC_ORIGIN;
    expect(await account()).toBe(false);
    service(ticketFor({ provider: "google", sub: "g-sam" }));
    expect(await (await exchange()).json()).toMatchObject({ error: "invalid_grant" });
  });

  it("a ticket for this server and this phone's key opens a read and write session bound to that key, as the account's person", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    const asked = service(ticketFor({ provider: "google", sub: "g-sam" }));
    const r = await exchange();
    expect(r.status).toBe(200);
    const t = (await r.json()) as { access_token: string; token_type: string; scope: string; expires_in: number };
    // never `access`: it can't make pairing links or manage sessions
    expect(t).toMatchObject({ token_type: "DPoP", scope: "read write" });
    const link = await app.request("http://localhost/api/auth/pairing-links", {
      method: "POST",
      headers: { authorization: `DPoP ${t.access_token}`, dpop: dpop("POST", "http://localhost/api/auth/pairing-links", t.access_token), "content-type": "application/json" },
      body: JSON.stringify({ deviceType: "mobile" }),
    });
    expect(link.status).toBe(403);
    expect(t.expires_in).toBeLessThanOrEqual(3600);
    expect(asked).toEqual([`${SERVICE}/api/account-signin/redeem`]);
    const me = await app.request("http://localhost/api/auth/session", {
      headers: { authorization: `DPoP ${t.access_token}`, dpop: dpop("GET", "http://localhost/api/auth/session", t.access_token) },
    });
    expect(((await me.json()) as { user: { username: string } }).user.username).toBe("tiny-sam");
  });

  it("finds the person by any sign-in of the account", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    service(ticketFor({ provider: "github", sub: "gh-1" }, { identities: [{ provider: "apple", sub: "a-alex" }] }));
    expect((await exchange()).status).toBe(200);
  });

  it("refuses an account whose sign-ins are two people here", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    service(ticketFor({ provider: "google", sub: "g-sam" }, { identities: [{ provider: "apple", sub: "a-alex" }] }));
    expect(await (await exchange()).json()).toMatchObject({ error: "invalid_grant" });
  });

  it("makes no account: a person with none here is refused", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    process.env.SIGN_UPS = "open";
    service(ticketFor({ provider: "google", sub: "g-nobody" }));
    expect(await (await exchange()).json()).toMatchObject({ error: "invalid_grant" });
    delete process.env.SIGN_UPS;
  });

  it("refuses a ticket for another key, another server, or a browser sign-in's ticket (no key, no server)", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    for (const who of [
      ticketFor({ provider: "google", sub: "g-sam" }, { jkt: "another-key" }),
      ticketFor({ provider: "google", sub: "g-sam" }, { host: "other.test.example" }),
      { provider: "google", sub: "g-sam", email: "", name: "" },
    ]) {
      service(who);
      expect(await (await exchange()).json(), JSON.stringify(who)).toMatchObject({ error: "invalid_grant" });
    }
  });

  it("asks the service nothing without the phone's DPoP proof or its verifier, or for no scope it can have", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    const asked = service(ticketFor({ provider: "google", sub: "g-sam" }));
    expect(await (await exchange({ bound: false })).json()).toMatchObject({ error: "invalid_grant" });
    expect(await (await exchange({ verifier: "" })).json()).toMatchObject({ error: "invalid_grant" });
    expect(await (await exchange({ scope: "admin" })).json()).toMatchObject({ error: "invalid_scope" });
    expect(await (await exchange({ scope: "access" })).json()).toMatchObject({ error: "invalid_scope" });
    expect(asked).toEqual([]);
  });

  it("a wrong verifier or a used ticket is refused", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    service(ticketFor({ provider: "google", sub: "g-sam" }));
    expect(await (await exchange({ verifier: "w".repeat(43) })).json()).toMatchObject({ error: "invalid_grant" });
    expect(await (await exchange({ ticket: "T2" })).json()).toMatchObject({ error: "invalid_grant" });
  });
});

describe("the Mac app's window, signed in with the account's ticket (POST /api/auth/account-ticket)", () => {
  const URL_ = "http://localhost/api/auth/account-ticket";
  const signIn = (o: { body?: unknown; proof?: string | null; type?: string } = {}) =>
    app.request(URL_, {
      method: "POST",
      headers: { "content-type": o.type ?? "application/json", ...(o.proof === null ? {} : { dpop: o.proof ?? dpop("POST", URL_) }) },
      body: JSON.stringify(o.body ?? { ticket: "T1", verifier: VERIFIER, client: { label: "Tiny Mac", os: "macOS 26", appVersion: "0.30.0", deviceType: "mobile" } }),
    });

  it("is the account itself: a cookie of its own session, listed as a computer under the name the app gave", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    service(ticketFor({ provider: "google", sub: "g-sam" }));
    const res = await signIn();
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect(cookie).toMatch(/^cap_auth=cts_/);
    const check = (await (await app.request("http://localhost/api/auth/check", { headers: { cookie } })).json()) as { authed: boolean; user: { username: string } };
    expect(check).toMatchObject({ authed: true, user: { username: "tiny-sam" } });
    const { clientSessions } = (await (await app.request("http://localhost/api/auth/access", { headers: { cookie } })).json()) as { clientSessions: Array<{ current: boolean; method: string; scopes: string[]; client: Record<string, string> }> };
    const mine = clientSessions.find((x) => x.current)!;
    // a computer whatever the app says of itself: only a phone's own sign-in is a phone's
    expect(mine).toMatchObject({ method: "browser-cookie", scopes: ["read", "write", "access"], client: { deviceType: "desktop", label: "Tiny Mac", os: "macOS 26", appVersion: "0.30.0" } });
  });

  it("sets no cookie for a ticket of another key, a person with no account here, or a body a form could send", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    service(ticketFor({ provider: "google", sub: "g-sam" }, { jkt: "another-key" }));
    for (const res of [await signIn(), await signIn({ proof: null }), await signIn({ type: "text/plain" })]) {
      expect(res.status).toBe(400);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    service(ticketFor({ provider: "google", sub: "g-nobody" }));
    const none = await signIn();
    expect(none.status).toBe(400);
    expect(none.headers.get("set-cookie")).toBeNull();
  });

  it("a proof works once", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    service(ticketFor({ provider: "google", sub: "g-sam" }));
    const proof = dpop("POST", URL_);
    expect((await signIn({ proof })).status).toBe(200);
    expect((await signIn({ proof })).status).toBe(400);
  });

  it("is not there on a server that names no sign-in service", async () => {
    expect((await signIn()).status).toBe(404);
  });
});

describe("tried too often from one address", () => {
  it("the 11th ticket in a minute waits, and the service is not asked", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    const asked = service(ticketFor({ provider: "google", sub: "g-sam" }));
    for (let i = 0; i < 10; i++) await exchange({ ticket: `T-${i}` });
    const r = await exchange();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(asked).toHaveLength(10);
  });

  it("counts per address, in a sliding minute", () => {
    const l = perMinute(2);
    expect([l.take("a", 0), l.take("a", 1), l.take("a", 2), l.take("b", 2)]).toEqual([true, true, false, true]);
    expect(l.take("a", 60_001)).toBe(true);
  });
});

describe("with no service named", () => {
  it("refuses every account ticket and asks no one", async () => {
    const asked = service(ticketFor({ provider: "google", sub: "g-sam" }));
    expect(await (await exchange()).json()).toMatchObject({ error: "invalid_grant" });
    expect(asked).toEqual([]);
  });
});
