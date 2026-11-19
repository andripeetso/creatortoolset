import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Phone sessions on a hosted server: they end with the account's cookies, never reach the account's keys, AI settings,
// computers or admin, and the access routes refuse a page from another site.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "auth-clients-hosted-"));
process.env.APP_SECRET = "hosted-clients-secret";
process.env.CT_MODE = "hosted";
process.env.PUBLIC_ORIGIN = "https://ct.test.example";

const app = (await import("./boot")).default;
const { env } = await import("./lib/env");
const { createUser, deleteUser, findUser, setPassword, setSignInCode } = await import("./users");

type Opts = { headers?: Record<string, string>; body?: unknown; form?: Record<string, string>; cookie?: string; token?: string; raw?: string };
function call(method: string, p: string, o: Opts = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.token) headers.authorization ??= `Bearer ${o.token}`;
  let body: string | undefined = o.raw;
  if (o.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(o.form).toString();
  } else if (o.body !== undefined) {
    headers["content-type"] ??= "application/json";
    body = JSON.stringify(o.body);
  }
  return app.request(`http://localhost${p}`, { method, headers, body }, { incoming: { socket: { remoteAddress: "10.0.0.20", remotePort: 50000, remoteFamily: "IPv4" } } });
}

async function login(username: string, password: string): Promise<string> {
  const r = await call("POST", "/api/auth/login", { body: { username, password } });
  expect(r.status).toBe(200);
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
}

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

async function newCode(cookie: string): Promise<string> {
  const link = await call("POST", "/api/auth/pairing-links", { cookie, body: { deviceType: "mobile" } });
  expect(link.status).toBe(200);
  return ((await link.json()) as { credential: string }).credential;
}
const exchange = (credential: string, bound = false) =>
  call("POST", "/oauth/token", {
    headers: bound ? { dpop: dpop("POST", "http://localhost/oauth/token") } : {},
    form: {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:creatortoolset:params:oauth:token-type:server-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    },
  });
/** A pairing link made by `cookie`'s account, swapped for a session (DPoP-bound when `bound`). */
async function pair(cookie: string, bound = false): Promise<string> {
  const r = await exchange(await newCode(cookie), bound);
  expect(r.status).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}

const endsSoon = (reader: ReadableStreamDefaultReader<Uint8Array>) =>
  Promise.race([
    (async () => {
      for (;;) if ((await reader.read()).done) return "ended";
    })(),
    new Promise<string>((ok) => setTimeout(() => ok("still open"), 3000)),
  ]);

let adminCookie = "";
beforeAll(async () => {
  adminCookie = await login(env.adminUsername, env.appSecret!);
});

describe("an account's phones are signed out with its browsers", () => {
  const cases: Array<[string, (username: string) => void]> = [
    ["a password change", (u) => setPassword(findUser(u)!, "a-new-password-2")],
    ["sign out everywhere", (u) => setSignInCode(findUser(u)!, null, true)],
    ["the account's deletion", (u) => void deleteUser(u)],
  ];
  for (const [what, end] of cases) {
    it(`after ${what}: an open token is refused and its open change stream ends`, async () => {
      const username = `tiny${randomUUID().slice(0, 8)}`;
      createUser(username, "tiny-password-1");
      const cookie = await login(username, "tiny-password-1");
      const token = await pair(cookie);
      const res = await call("GET", "/api/sync/events", { token });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      await reader.read(); // the hello
      // an unused link of the account goes too
      const left = await newCode(cookie);
      end(username);
      expect(await endsSoon(reader)).toBe("ended");
      const s = await call("GET", "/api/auth/session", { token });
      expect(s.status).toBe(401);
      expect(await s.json()).toMatchObject({ code: "SESSION_REVOKED" });
      expect(await (await exchange(left)).json()).toMatchObject({ error: "invalid_grant" });
    });
  }

  it("another account's phone keeps working", async () => {
    const token = await pair(adminCookie);
    const username = `tiny${randomUUID().slice(0, 8)}`;
    createUser(username, "tiny-password-1");
    setPassword(findUser(username)!, "a-new-password-2");
    expect((await call("GET", "/api/auth/session", { token })).status).toBe(200);
  });
});

describe("a phone's session never reaches the account's keys, AI settings, computers or admin", () => {
  const PREFIXES = ["admin", "workspace", "providers", "devices", "service-keys", "my-keys"];
  let bearer = "";
  let bound = "";
  beforeAll(async () => {
    bearer = await pair(adminCookie);
    bound = await pair(adminCookie, true);
  });
  for (const p of PREFIXES) {
    it(`/api/${p}, Bearer and DPoP, read and write`, async () => {
      for (const method of ["GET", "POST"]) {
        const url = `/api/${p}${method === "POST" ? "/x" : ""}`;
        const b = await call(method, url, { token: bearer, ...(method === "POST" ? { body: {} } : {}) });
        expect(b.status).toBe(403);
        expect(await b.json()).toMatchObject({ code: "NOT_FOR_CLIENTS" });
        const d = await call(method, url, {
          headers: { authorization: `DPoP ${bound}`, dpop: dpop(method, `http://localhost${url}`, bound) },
          ...(method === "POST" ? { body: {} } : {}),
        });
        expect(d.status).toBe(403);
        expect(await d.json()).toMatchObject({ code: "NOT_FOR_CLIENTS" });
      }
    });
  }
  it("the same sessions still open the rest of the app", async () => {
    expect((await call("GET", "/api/auth/session", { token: bearer })).status).toBe(200);
    expect((await call("GET", "/api/sync/events", { token: bearer })).status).toBe(200);
    expect((await call("GET", "/api/auth/session", { headers: { authorization: `DPoP ${bound}`, dpop: dpop("GET", "http://localhost/api/auth/session", bound) } })).status).toBe(200);
  });
});

describe("the access routes refuse a page from another site", () => {
  const ROUTES: Array<[string, unknown]> = [
    ["/api/auth/pairing-links", {}],
    ["/api/auth/pairing-links/revoke", { id: "pl_none" }],
    ["/api/auth/clients/revoke", { sessionId: "cs_none" }],
    ["/api/auth/clients/revoke-others", {}],
  ];
  for (const [route, body] of ROUTES) {
    it(`${route}: another Origin or a non-JSON body is refused; its own origin and a device token are not`, async () => {
      const evil = await call("POST", route, { cookie: adminCookie, body, headers: { origin: "https://evil.example" } });
      expect(evil.status).toBe(403);
      const form = await call("POST", route, { cookie: adminCookie, raw: JSON.stringify(body), headers: { "content-type": "text/plain" } });
      expect(form.status).toBe(403);
      const own = await call("POST", route, { cookie: adminCookie, body, headers: { origin: "https://ct.test.example" } });
      expect(own.status).not.toBe(403);
      const plain = await call("POST", route, { cookie: adminCookie, body });
      expect(plain.status).not.toBe(403);
    });
  }
  // the connect routes may still refuse for their own reasons (owner only, this computer only); only the site check is asked
  for (const route of ["/api/connect/notifications", "/api/connect/ai", "/api/connect/link-proof", "/api/connect/relay-config"]) {
    it(`${route}: a cookie POST from another site or without JSON is refused; its own origin is not`, async () => {
      const said = async (r: Response) => ((await r.json().catch(() => ({}))) as { error?: string }).error;
      expect(await said(await call("POST", route, { cookie: adminCookie, body: {}, headers: { origin: "https://evil.example" } }))).toBe("Sent from another site");
      expect(await said(await call("POST", route, { cookie: adminCookie, raw: "{}", headers: { "content-type": "text/plain" } }))).toBe("Sent from another site");
      expect(await said(await call("POST", route, { cookie: adminCookie, body: {}, headers: { origin: "https://ct.test.example" } }))).not.toBe("Sent from another site");
      expect(await said(await call("POST", route, { body: {} }))).not.toBe("Sent from another site"); // the connect service: JSON, no Origin, no cookie
    });
  }
  it("a device's token is exempt, and the form-encoded /oauth/token still works", async () => {
    const token = await pair(adminCookie); // /oauth/token is form-encoded, with no cookie
    const r = await call("POST", "/api/auth/clients/revoke-others", { token, headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(200);
  });
});
