import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 }); // scrypt and the deliberate delay after each wrong try, beside the whole suite

// The sign-in code on a server on this Mac (CT_LOCAL=1, what the Mac app runs), through the real routes: switching it
// on, the code step after a password, recovery codes, the Mac window's own sign-in (never asked, never locked) against
// the tunnel, a proxy and the network (always asked), and the lock on wrong tries.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "sign-in-code-"));
process.env.APP_SECRET = "sign-in-code-test-secret";
process.env.CT_LOCAL = "1";
delete process.env.CT_MODE;

const { base32, codeAt, stepOf } = await import("./lib/sign-in-code");
const { createUser, findUser } = await import("./users");
const app = (await import("./boot")).default;

// a clock the test moves: each code is good for 30 s and a step that signed in never works again
let clock = Date.UTC(2026, 10, 11, 12, 0, 0);
beforeAll(() => void vi.spyOn(Date, "now").mockImplementation(() => clock));
afterAll(() => vi.restoreAllMocks());
const later = (ms: number) => void (clock += ms);

const LAN = "203.0.113.7";
type Opts = { address?: string; host?: string; headers?: Record<string, string>; cookie?: string; body?: unknown };
const req = (method: string, p: string, o: Opts = {}) => {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const address = o.address ?? "127.0.0.1";
  return Promise.resolve(
    app.request(
      `http://${o.host ?? "localhost"}${p}`,
      { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) },
      { incoming: { socket: { remoteAddress: address, remotePort: 50000, remoteFamily: address.includes(":") ? "IPv6" : "IPv4" } } },
    ),
  );
};
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const authed = async (cookie: string) => ((await (await req("GET", "/api/auth/check", { cookie })).json()) as { authed: boolean }).authed;
const login = (username: string, password: string, o: Opts = {}) => req("POST", "/api/auth/login", { ...o, body: { username, password } });

function unbase32(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let v = 0;
  const out: number[] = [];
  for (const ch of s) {
    v = (v << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((v >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
/** The code an authenticator app shows for this secret right now. */
const codeNow = (secret: string) => codeAt(unbase32(secret), Math.floor(Date.now() / 30_000));

const OWNER = { username: "admin", password: "tinyacrobatics-owner" };
let secret = "";
let recovery: string[] = [];
let lanCookie = "";

describe("the code itself", () => {
  it("is RFC 6238's: the test vectors, and a step either side", () => {
    const key = Buffer.from("12345678901234567890");
    expect(base32(key)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(codeAt(key, Math.floor(59 / 30))).toBe("287082");
    expect(codeAt(key, Math.floor(1111111109 / 30))).toBe("081804");
    expect(codeAt(key, Math.floor(1234567890 / 30))).toBe("005924");
    expect(codeAt(key, Math.floor(2000000000 / 30))).toBe("279037");
    const hex = key.toString("hex");
    expect(stepOf(hex, "081804", 1111111109_000)).toBe(37037036);
    expect(stepOf(hex, "081804", (1111111109 + 30) * 1000)).toBe(37037036);
    expect(stepOf(hex, "081804", (1111111109 + 60) * 1000)).toBeNull();
    expect(stepOf(hex, "81804", 1111111109_000)).toBeNull();
  });
});

describe("switching it on (Settings → Account)", () => {
  let windowCookie = "";

  beforeAll(async () => {
    // the owner chooses a password of their own first, as Access from other devices does; the LAN can sign in after that
    const first = cookieOf(await login("admin", "sign-in-code-test-secret"));
    windowCookie = cookieOf(await req("POST", "/api/auth/password", { cookie: first, body: { current: "sign-in-code-test-secret", password: OWNER.password } }));
    lanCookie = cookieOf(await login(OWNER.username, OWNER.password, { address: LAN }));
    expect(await authed(lanCookie)).toBe(true);
  });

  it("a QR's secret, confirmed by one code; recovery codes once; every other browser is signed out", async () => {
    expect(await (await req("GET", "/api/auth/code", { address: LAN, cookie: lanCookie })).json()).toEqual({ on: false, required: false, mac: false });
    const made = await req("POST", "/api/auth/code/new", { address: LAN, cookie: lanCookie, body: {} });
    expect(made.status).toBe(200);
    ({ secret } = (await made.json()) as { secret: string; uri: string });
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    expect((await req("POST", "/api/auth/code/on", { address: LAN, cookie: lanCookie, body: { code: "000000" } })).status).toBe(400);
    const on = await req("POST", "/api/auth/code/on", { address: LAN, cookie: lanCookie, body: { code: codeNow(secret) } });
    expect(on.status).toBe(200);
    ({ recovery } = (await on.json()) as { recovery: string[] });
    expect(recovery).toHaveLength(10);
    expect(new Set(recovery).size).toBe(10);
    // this browser keeps going on its fresh cookie; the Mac window's older cookie is signed out
    lanCookie = cookieOf(on);
    expect(await authed(lanCookie)).toBe(true);
    expect(await authed(windowCookie)).toBe(false);
    // a second secret can't replace the first while it is on
    expect((await req("POST", "/api/auth/code/new", { address: LAN, cookie: lanCookie, body: {} })).status).toBe(409);
  });

  it("never hands the secret or the recovery codes out again", async () => {
    const user = findUser("admin")!;
    const answers = [
      await (await req("GET", "/api/auth/code", { address: LAN, cookie: lanCookie })).text(),
      await (await req("GET", "/api/auth/account", { address: LAN, cookie: lanCookie })).text(),
      await (await req("GET", "/api/auth/check", { address: LAN, cookie: lanCookie })).text(),
    ].join("\n");
    for (const s of [secret, user.code!.secret, ...recovery, ...user.code!.recovery]) expect(answers).not.toContain(s);
    expect(JSON.parse(answers.split("\n")[0]!)).toEqual({ on: true, required: false, mac: false });
  });
});

describe("signing in with the code on", () => {
  it("a password alone sets no cookie: a step token, an error sentence for an app that can't take a code", async () => {
    later(30_000);
    const res = await login(OWNER.username, OWNER.password, { address: LAN });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const b = (await res.json()) as { error: string; code: string; step: string };
    expect(b.code).toBe("CODE_NEEDED");
    expect(b.error).toMatch(/authenticator app/);
    expect(b.step).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // the token is no session
    expect(await authed(`cap_auth=${b.step}`)).toBe(false);
    // a code token can't set up another secret
    expect((await req("POST", "/api/auth/code/new", { address: LAN, body: { step: b.step } })).status).toBe(401);

    const wrong = await req("POST", "/api/auth/code", { address: LAN, body: { step: b.step, code: "000000" } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(await wrong.json()).toEqual({ error: "Wrong code" });

    const right = await req("POST", "/api/auth/code", { address: LAN, body: { step: b.step, code: codeNow(secret) } });
    expect(right.status).toBe(200);
    expect(await right.json()).toMatchObject({ ok: true, user: { username: "admin" } });
    expect(await authed(cookieOf(right))).toBe(true);

    // the token worked once; the same code (its step signed in) works no more either
    expect((await req("POST", "/api/auth/code", { address: LAN, body: { step: b.step, code: codeNow(secret) } })).status).toBe(401);
    const again = (await (await login(OWNER.username, OWNER.password, { address: LAN })).json()) as { step: string };
    expect((await req("POST", "/api/auth/code", { address: LAN, body: { step: again.step, code: codeNow(secret) } })).status).toBe(401);
    later(30_000);
    expect((await req("POST", "/api/auth/code", { address: LAN, body: { step: again.step, code: codeNow(secret) } })).status).toBe(200);
  });

  it("the step token expires after 5 minutes", async () => {
    const { step } = (await (await login(OWNER.username, OWNER.password, { address: LAN })).json()) as { step: string };
    later(5 * 60_000 + 1000);
    const res = await req("POST", "/api/auth/code", { address: LAN, body: { step, code: codeNow(secret) } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "That sign-in expired. Sign in again.", code: "STEP_EXPIRED" });
  });

  it("a recovery code works in the code's place, once", async () => {
    const use = async () => {
      const { step } = (await (await login(OWNER.username, OWNER.password, { address: LAN })).json()) as { step: string };
      return req("POST", "/api/auth/code", { address: LAN, body: { step, code: recovery[0]!.toUpperCase() } });
    };
    expect((await use()).status).toBe(200);
    expect((await use()).status).toBe(401);
    expect(findUser("admin")!.code!.recovery).toHaveLength(9);
  });

  it("a one-time link from a signed-in browser carries its session to a phone", async () => {
    vi.stubEnv("HOST", "127.0.0.1");
    const minted = (await (await req("POST", "/api/auth/link", { address: LAN, cookie: lanCookie })).json()) as { path: string };
    const opened = await req("GET", minted.path, { address: LAN });
    expect(opened.status).toBe(302);
    expect(await authed(cookieOf(opened))).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("this Mac's own window, and everything that only looks like it", () => {
  it("the window signs in with no code", async () => {
    const res = await login(OWNER.username, OWNER.password);
    expect(res.status).toBe(200);
    expect(await authed(cookieOf(res))).toBe(true);
    const v6 = await login(OWNER.username, OWNER.password, { address: "::1", host: "[::1]:43127" });
    expect(v6.status).toBe(200);
  });

  it("the tunnel, a proxy, another name for this Mac, the network and a hosted server are all asked", async () => {
    const asked = async (o: Opts) => {
      const res = await login(OWNER.username, OWNER.password, o);
      expect(res.headers.get("set-cookie")).toBeNull();
      return ((await res.json()) as { code?: string }).code;
    };
    expect(await asked({ headers: { "cf-connecting-ip": "198.51.100.9" } })).toBe("CODE_NEEDED");
    expect(await asked({ headers: { "cf-ray": "8f00-AMS" } })).toBe("CODE_NEEDED");
    for (const h of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "via"]) {
      expect(await asked({ headers: { [h]: h === "x-forwarded-proto" ? "https" : "198.51.100.9" } })).toBe("CODE_NEEDED");
    }
    expect(await asked({ host: `${hostname().toLowerCase().replace(/\.local$/, "")}.local` })).toBe("CODE_NEEDED");
    expect(await asked({ address: LAN })).toBe("CODE_NEEDED");
    expect(await asked({ address: "2001:db8::7" })).toBe("CODE_NEEDED");
    vi.stubEnv("CT_MODE", "hosted");
    expect(await asked({})).toBe("CODE_NEEDED");
    vi.stubEnv("CT_LOCAL", "");
    expect(await asked({})).toBe("CODE_NEEDED");
    vi.unstubAllEnvs();
  });
});

describe("the lock on wrong tries", { timeout: 30_000 }, () => {
  const TINA = { username: "tina", password: "tina-password-1" };
  beforeAll(() => void createUser(TINA.username, TINA.password));

  it("five wrong passwords lock the account from every address, a right one included; the wait grows", async () => {
    for (let i = 0; i < 5; i++) expect((await login(TINA.username, "wrong-guess", { address: `198.51.100.${i + 1}` })).status).toBe(401);
    const held = await login(TINA.username, TINA.password, { address: LAN });
    expect(held.status).toBe(429);
    expect(held.headers.get("retry-after")).toBe("60");
    expect(await held.json()).toEqual({ error: "Too many wrong tries. Try again in 1 minute.", code: "LOCKED" });
    later(61_000);
    expect((await login(TINA.username, "wrong-guess", { address: LAN })).status).toBe(401);
    expect(await (await login(TINA.username, TINA.password, { address: LAN })).json()).toMatchObject({ error: "Too many wrong tries. Try again in 2 minutes." });
    later(121_000);
    const back = await login(TINA.username, TINA.password, { address: LAN });
    expect(back.status).toBe(200);
    // a sign-in clears it
    for (let i = 0; i < 4; i++) await login(TINA.username, "wrong-guess", { address: LAN });
    expect((await login(TINA.username, TINA.password, { address: LAN })).status).toBe(200);
  });

  it("a name no account has is held the same way, so the answer says nothing about which names exist", async () => {
    for (let i = 0; i < 5; i++) await login("nobody-here", "wrong-guess", { address: LAN });
    expect(await (await login("nobody-here", "wrong-guess", { address: LAN })).json()).toEqual({ error: "Too many wrong tries. Try again in 1 minute.", code: "LOCKED" });
    later(61_000);
  });

  it("wrong codes count with wrong passwords, and a right password between them clears nothing", async () => {
    const step = async () => ((await (await login(OWNER.username, OWNER.password, { address: LAN })).json()) as { step: string }).step;
    let s = await step();
    for (let i = 0; i < 4; i++) expect((await req("POST", "/api/auth/code", { address: LAN, body: { step: s, code: "000000" } })).status).toBe(401);
    s = await step();
    expect((await req("POST", "/api/auth/code", { address: LAN, body: { step: s, code: "000000" } })).status).toBe(401);
    // locked now: the code step and the password step both wait, even with the right code
    expect((await req("POST", "/api/auth/code", { address: LAN, body: { step: s, code: codeNow(secret) } })).status).toBe(429);
    expect((await login(OWNER.username, OWNER.password, { address: LAN })).status).toBe(429);
    expect((await login(OWNER.username, OWNER.password, { address: LAN, headers: { "x-forwarded-for": "127.0.0.1" } })).status).toBe(429);
  });

  it("never holds this Mac's window back, and the window's wrong tries are not counted", async () => {
    expect((await login(OWNER.username, "a-keychain-password-from-before")).status).toBe(401);
    const res = await login(OWNER.username, OWNER.password);
    expect(res.status).toBe(200);
    later(61_000);
    // the window's sign-in set a cookie, so the count started again; the LAN gets the code step
    expect(((await (await login(OWNER.username, OWNER.password, { address: LAN })).json()) as { code: string }).code).toBe("CODE_NEEDED");
  });
});

describe("switching it off", () => {
  it("needs a current code or a recovery code, but not in this Mac's window", async () => {
    expect(await (await req("POST", "/api/auth/code/off", { address: LAN, cookie: lanCookie, body: { code: "000000" } })).json()).toEqual({ error: "Wrong code" });
    expect((await req("POST", "/api/auth/code/off", { address: LAN, cookie: lanCookie, body: { code: recovery[1] } })).status).toBe(200);
    expect(findUser("admin")!.code).toBeUndefined();
    // off: the LAN signs in with the password alone again
    expect((await login(OWNER.username, OWNER.password, { address: LAN })).status).toBe(200);

    // on again, then off from the window with nothing typed (a lost phone)
    const { secret: s2 } = (await (await req("POST", "/api/auth/code/new", { address: LAN, cookie: lanCookie, body: {} })).json()) as { secret: string };
    lanCookie = cookieOf(await req("POST", "/api/auth/code/on", { address: LAN, cookie: lanCookie, body: { code: codeNow(s2) } }));
    const windowCookie = cookieOf(await login(OWNER.username, OWNER.password));
    expect((await req("GET", "/api/auth/code", { cookie: windowCookie })).ok).toBe(true);
    expect(((await (await req("GET", "/api/auth/code", { cookie: windowCookie })).json()) as { mac: boolean }).mac).toBe(true);
    expect((await req("POST", "/api/auth/code/off", { cookie: windowCookie, body: {} })).status).toBe(200);
    expect(findUser("admin")!.code).toBeUndefined();
  });

  it("a password change keeps it switched on", async () => {
    const { secret: s3 } = (await (await req("POST", "/api/auth/code/new", { address: LAN, cookie: lanCookie, body: {} })).json()) as { secret: string };
    lanCookie = cookieOf(await req("POST", "/api/auth/code/on", { address: LAN, cookie: lanCookie, body: { code: codeNow(s3) } }));
    const changed = await req("POST", "/api/auth/password", { address: LAN, cookie: lanCookie, body: { current: OWNER.password, password: "tinyacrobatics-owner-2" } });
    expect(changed.status).toBe(200);
    expect(findUser("admin")!.code).toBeDefined();
    expect(((await (await login(OWNER.username, "tinyacrobatics-owner-2", { address: LAN })).json()) as { code: string }).code).toBe("CODE_NEEDED");
  });
});

describe("a new password is 10 characters or more", () => {
  it("is asked when one is set, and an older shorter password keeps signing in", async () => {
    createUser("olde", "password1");
    const cookie = cookieOf(await login("olde", "password1", { address: LAN }));
    expect(await authed(cookie)).toBe(true);
    const short = await req("POST", "/api/auth/password", { address: LAN, cookie, body: { current: "password1", password: "123456789" } });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: "Password must be at least 10 characters" });
    expect((await req("POST", "/api/auth/password", { address: LAN, cookie, body: { current: "password1", password: "1234567890" } })).status).toBe(200);
  });
});
