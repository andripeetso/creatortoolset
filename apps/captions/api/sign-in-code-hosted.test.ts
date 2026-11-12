import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 }); // scrypt and the deliberate delay after each wrong try, beside the whole suite

// The sign-in code on a hosted server (CT_MODE=hosted), through the real routes: an admin asks everyone for one (a new
// sign-in sets one up before anything opens; an invite's new account too), lifts a lock, switches off a person's code
// after a lost phone. A provider sign-in an app swaps (POST /api/auth/app) keeps its own proof.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "sign-in-code-hosted-"));
process.env.APP_SECRET = "sign-in-code-hosted-secret";
process.env.CT_MODE = "hosted";
delete process.env.CT_LOCAL;

const { codeAt } = await import("./lib/sign-in-code");
const { mintAppCode } = await import("./auth");
const { createUser, findUser } = await import("./users");
const app = (await import("./boot")).default;

let clock = Date.UTC(2026, 10, 11, 12, 0, 0);
beforeAll(() => void vi.spyOn(Date, "now").mockImplementation(() => clock));
afterAll(() => vi.restoreAllMocks());
const later = (ms: number) => void (clock += ms);

const call = (method: string, p: string, cookie?: string, body?: unknown) =>
  Promise.resolve(
    app.request(`http://localhost${p}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const authed = async (cookie: string) => ((await (await call("GET", "/api/auth/check", cookie)).json()) as { authed: boolean }).authed;
const login = (username: string, password: string) => call("POST", "/api/auth/login", undefined, { username, password });
/** A sign-in as a server behind its proxy gets it: from the proxy on this computer, with the client in X-Forwarded-For. */
const loginVia = (client: string, username: string, password: string) =>
  Promise.resolve(
    app.request(
      "http://localhost/api/auth/login",
      { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": client }, body: JSON.stringify({ username, password }) },
      { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50000, remoteFamily: "IPv4" } } },
    ),
  );
const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const unbase32 = (s: string) => {
  let bits = 0;
  let v = 0;
  const out: number[] = [];
  for (const ch of s) {
    v = (v << 5) | A.indexOf(ch);
    if ((bits += 5) >= 8) out.push((v >>> (bits -= 8)) & 255);
  }
  return Buffer.from(out);
};
const codeNow = (secret: string) => codeAt(unbase32(secret), Math.floor(Date.now() / 30_000));

const ADMIN = { username: "admin", password: "sign-in-code-hosted-secret" };
const MIA = { username: "mia", password: "mia-password-1" };
let admin = "";
let miaSecret = "";

describe("an admin asks everyone for a sign-in code", () => {
  let miaBefore = "";

  beforeAll(async () => {
    admin = cookieOf(await login(ADMIN.username, ADMIN.password));
    createUser(MIA.username, MIA.password);
    miaBefore = cookieOf(await login(MIA.username, MIA.password));
  });

  it("needs the admin's own code first", async () => {
    const res = await call("PUT", "/api/admin/sign-in-code", admin, { required: true });
    expect(res.status).toBe(400);
    const { secret } = (await (await call("POST", "/api/auth/code/new", admin, {})).json()) as { secret: string };
    const on = await call("POST", "/api/auth/code/on", admin, { code: codeNow(secret) });
    expect(on.status).toBe(200);
    admin = cookieOf(on);
  });

  it("signs out everyone without one; their next password sign-in sets one up before any cookie", async () => {
    expect(await (await call("PUT", "/api/admin/sign-in-code", admin, { required: true })).json()).toEqual({ required: true });
    expect(await authed(miaBefore)).toBe(false);
    expect(await authed(admin)).toBe(true);

    const pw = await login(MIA.username, MIA.password);
    expect(pw.status).toBe(401);
    expect(pw.headers.get("set-cookie")).toBeNull();
    const { code, step } = (await pw.json()) as { code: string; step: string };
    expect(code).toBe("CODE_SETUP");
    // the setup token is no session either, and a wrong code is refused
    expect(await authed(`cap_auth=${step}`)).toBe(false);
    ({ secret: miaSecret } = (await (await call("POST", "/api/auth/code/new", undefined, { step })).json()) as { secret: string });
    expect((await call("POST", "/api/auth/code", undefined, { step, code: "000000" })).status).toBe(401);
    const done = await call("POST", "/api/auth/code", undefined, { step, code: codeNow(miaSecret) });
    expect(done.status).toBe(200);
    const b = (await done.json()) as { ok: boolean; recovery: string[]; user: { username: string } };
    expect(b.recovery).toHaveLength(10);
    expect(b.user.username).toBe("mia");
    expect(await authed(cookieOf(done))).toBe(true);
    // from now on mia's sign-in asks for her code, and a code token sets up nothing
    later(30_000);
    const next = (await (await login(MIA.username, MIA.password)).json()) as { code: string; step: string };
    expect(next.code).toBe("CODE_NEEDED");
    expect((await call("POST", "/api/auth/code/new", undefined, { step: next.step })).status).toBe(401);
    expect((await call("POST", "/api/auth/code", undefined, { step: next.step, code: codeNow(miaSecret) })).status).toBe(200);
  });

  it("an invite's new account gets no cookie: it signs in with its password and sets one up", async () => {
    const { token } = (await (await call("POST", "/api/workspace/invites", admin, { ai: "own", budgetUsd: 0 })).json()) as { token: string };
    const joined = await call("POST", `/api/auth/invite/${token}`, undefined, { username: "noel", password: "noel-password-1" });
    expect(joined.status).toBe(200);
    expect(await joined.json()).toEqual({ ok: true, username: "noel" });
    expect(joined.headers.get("set-cookie")).toBeNull();
    expect(((await (await login("noel", "noel-password-1")).json()) as { code: string }).code).toBe("CODE_SETUP");
  });

  it("no one switches their own off while the server asks for it", async () => {
    expect(await (await call("POST", "/api/auth/code/off", admin, { code: codeNow(miaSecret) })).json()).toEqual({ error: "This server asks everyone for a sign-in code" });
  });
});

describe("an admin helps a person who is locked out or lost their phone", () => {
  type Row = { username: string; code: boolean; locked: boolean };
  const row = async (name: string) => ((await (await call("GET", "/api/admin/users", admin)).json()) as Row[]).find((u) => u.username === name)!;

  it("lists who has a code and who is locked, never the secret", async () => {
    const text = await (await call("GET", "/api/admin/users", admin)).text();
    expect(text).not.toContain(findUser("mia")!.code!.secret);
    expect(text).not.toContain(miaSecret);
    expect(await row("mia")).toMatchObject({ code: true, locked: false });
    expect(await row("noel")).toMatchObject({ code: false, locked: false });
  });

  it("behind its proxy, a stranger's guesses lock only the stranger; the admin lifts the lock on every address", { timeout: 60_000 }, async () => {
    for (const stranger of ["198.51.100.1", "198.51.100.2"]) for (let i = 0; i < 5; i++) await loginVia(stranger, MIA.username, "wrong-guess");
    expect((await loginVia("198.51.100.1", MIA.username, MIA.password)).status).toBe(429);
    expect((await loginVia("198.51.100.2", MIA.username, MIA.password)).status).toBe(429);
    // mia on her own address is not held
    expect(((await (await loginVia("203.0.113.8", MIA.username, MIA.password)).json()) as { code: string }).code).toBe("CODE_NEEDED");
    expect(await row("mia")).toMatchObject({ locked: true });
    expect((await call("PATCH", "/api/admin/users/mia", admin, { unlock: true })).status).toBe(200);
    expect(await row("mia")).toMatchObject({ locked: false });
    for (const stranger of ["198.51.100.1", "198.51.100.2"]) {
      expect(((await (await loginVia(stranger, MIA.username, MIA.password)).json()) as { code: string }).code).toBe("CODE_NEEDED");
    }
  });

  it("switches a person's code off; with the server's ask off too, the password alone signs in again", async () => {
    expect((await call("PATCH", "/api/admin/users/mia", admin, { code: false })).status).toBe(200);
    expect(findUser("mia")!.code).toBeUndefined();
    expect(((await (await login(MIA.username, MIA.password)).json()) as { code: string }).code).toBe("CODE_SETUP");
    expect(await (await call("PUT", "/api/admin/sign-in-code", admin, { required: false })).json()).toEqual({ required: false });
    const res = await login(MIA.username, MIA.password);
    expect(res.status).toBe(200);
    expect(await authed(cookieOf(res))).toBe(true);
  });

  it("a member can't ask everyone, lift a lock or switch anyone's code off", async () => {
    const mia = cookieOf(await login(MIA.username, MIA.password));
    expect((await call("PUT", "/api/admin/sign-in-code", mia, { required: true })).status).toBe(403);
    expect((await call("PATCH", "/api/admin/users/admin", mia, { code: false })).status).toBe(403);
  });
});

describe("a provider sign-in keeps its own proof", () => {
  it("an app's code swap signs in an account that has the code on, with no code asked", async () => {
    expect(findUser("admin")!.code).toBeDefined();
    const verifier = "z".repeat(43);
    const code = mintAppCode(findUser("admin")!, createHash("sha256").update(verifier).digest("base64url"));
    const res = await call("POST", "/api/auth/app", undefined, { code, verifier });
    expect(res.status).toBe(200);
    expect(await authed(cookieOf(res))).toBe(true);
  });
});
