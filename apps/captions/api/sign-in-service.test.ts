import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Sign in with Google / Apple through the account sign-in service a server names in its .env (sign-in.ts): off unless
// named, nothing asked of the service until a person presses the button, and its answer checked like a provider's.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "sign-in-service-"));
process.env.APP_SECRET = "sign-in-service-test-secret";
process.env.CT_MODE = "hosted";
for (const k of ["APPLE_SIGNIN_KEY", "GOOGLE_SIGNIN_CLIENT_ID", "GOOGLE_SIGNIN_CLIENT_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "ACCOUNT_SIGNIN_SERVICE", "SIGN_UPS"]) delete process.env[k];

const { createUser, findByIdentity, findUser, linkIdentity } = await import("./users");
const { signinService } = await import("./sign-in");
const app = (await import("./boot")).default;

const SERVICE = "https://signin.test";
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const providers = async () => (await app.request("/api/account/providers")).json();

/** The service's redeem, faked: it pays out `who` only to the verifier whose hash came with the start. */
function service(who: Record<string, unknown>, challenge: () => string) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    asked.push(String(url));
    const { ticket, verifier } = JSON.parse(String(init?.body)) as { ticket: string; verifier: string };
    const ok = ticket === "T1" && createHash("sha256").update(verifier).digest("base64url") === challenge();
    return ok ? Response.json(who) : Response.json({ error: "That sign-in was started somewhere else" }, { status: 403 });
  });
  return asked;
}

/** Starts a sign-in here and returns where the browser is sent: the service's start page with this server's way back. */
async function start(kind: string, forWhat: string, cookie?: string) {
  const res = await app.request(`/api/account/login/${kind}?for=${forWhat}`, cookie ? { headers: { cookie } } : undefined);
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ACCOUNT_SIGNIN_SERVICE;
});

describe("with no service named (the default)", () => {
  it("offers nothing and asks no one", async () => {
    const asked = service({}, () => "");
    expect(await providers()).toEqual({ apple: false, google: false, github: false });
    expect((await app.request("/api/account/login/google?for=site")).status).toBe(501);
    expect(asked).toEqual([]);
  });

  it("takes only an https address (or this computer's) as the service", () => {
    for (const bad of ["http://signin.test", "https://signin.test/path", "https://user@signin.test", "signin.test", ""]) {
      process.env.ACCOUNT_SIGNIN_SERVICE = bad;
      expect(signinService(), bad).toBe("");
    }
    process.env.ACCOUNT_SIGNIN_SERVICE = "https://signin.test/";
    expect(signinService()).toBe(SERVICE);
    process.env.ACCOUNT_SIGNIN_SERVICE = "http://127.0.0.1:5471";
    expect(signinService()).toBe("http://127.0.0.1:5471");
  });
});

describe("with a service named in the server's .env", () => {
  it("shows the Google and Apple buttons and starts at the service, without asking it anything first", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    const asked = service({}, () => "");
    expect(await providers()).toEqual({ apple: true, google: true, github: false });
    const to = await start("google", "site");
    expect(`${to.origin}${to.pathname}`).toBe(`${SERVICE}/api/account-signin/start/google`);
    expect(to.searchParams.get("return")).toBe("http://localhost/api/auth/service/callback");
    expect(to.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // the verifier stays on this server
    expect(to.search).not.toContain("verifier");
    expect((await start("apple", "site")).pathname).toBe("/api/account-signin/start/apple");
    expect((await app.request("/api/account/login/github?for=site")).status).toBe(501);
    expect(asked).toEqual([]);
  });

  it("signs a linked account in with what the service vouches for, once", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    createUser("ana", "anapass12", { role: "user" });
    linkIdentity(findUser("ana")!, { provider: "google", sub: "g-77", email: "ana@example.test" });
    const to = await start("google", "site");
    const asked = service({ provider: "google", sub: "g-77", email: "ana@example.test", name: "Ana" }, () => to.searchParams.get("challenge")!);
    const state = to.searchParams.get("state")!;
    const back = await app.request(`/api/auth/service/callback?state=${state}&ticket=T1`);
    expect(back.headers.get("location")).toBe("/");
    expect(cookieOf(back)).toMatch(/=/);
    expect(asked).toEqual([`${SERVICE}/api/account-signin/redeem`]);
    // the state is single use
    const again = await app.request(`/api/auth/service/callback?state=${state}&ticket=T1`);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(asked).toHaveLength(1);
  });

  it("signs no one in for an identity with no account here, for another provider than was asked, or with no id", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ provider: "google", sub: "g-stranger", email: "x@example.test", name: "X" }, /no%20account%20here/],
      [{ provider: "apple", sub: "g-77" }, /Sign-in%20failed/],
      [{ provider: "google", sub: "" }, /Sign-in%20failed/],
      [{ provider: "google" }, /Sign-in%20failed/],
    ];
    for (const [who, says] of cases) {
      const to = await start("google", "site");
      service(who, () => to.searchParams.get("challenge")!);
      const back = await app.request(`/api/auth/service/callback?state=${to.searchParams.get("state")}&ticket=T1`);
      expect(back.headers.get("location"), JSON.stringify(who)).toMatch(says);
      expect(back.headers.get("location")).toMatch(/^\/login\?error=/);
      expect(back.headers.get("set-cookie")).toBeNull();
      vi.unstubAllGlobals();
    }
    expect(findByIdentity("google", "g-stranger")).toBeNull();
  });

  it("says what the service said when it sends the person back without a ticket, and asks it nothing", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    const to = await start("google", "site");
    const asked = service({}, () => "");
    const back = await app.request(`/api/auth/service/callback?state=${to.searchParams.get("state")}&error=${encodeURIComponent("Sign-in was cancelled")}`);
    expect(back.headers.get("location")).toBe("/login?error=Sign-in%20was%20cancelled");
    expect(asked).toEqual([]);
  });

  it("links a sign-in to the account that started it, only in the browser that started it", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    createUser("ben", "benpass12", { role: "user" });
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "ben", password: "benpass12" }) });
    const cookie = cookieOf(login);

    // the way back in another browser (no session): nothing is linked
    let to = await start("apple", "link", cookie);
    service({ provider: "apple", sub: "a-9", email: "", name: "Ben" }, () => to.searchParams.get("challenge")!);
    const elsewhere = await app.request(`/api/auth/service/callback?state=${to.searchParams.get("state")}&ticket=T1`);
    expect(elsewhere.headers.get("location")).toMatch(/^\/settings\/account\?signin=Finish%20linking/);
    expect(findByIdentity("apple", "a-9")).toBeNull();
    vi.unstubAllGlobals();

    to = await start("apple", "link", cookie);
    service({ provider: "apple", sub: "a-9", email: "", name: "Ben" }, () => to.searchParams.get("challenge")!);
    const back = await app.request(`/api/auth/service/callback?state=${to.searchParams.get("state")}&ticket=T1`, { headers: { cookie } });
    expect(back.headers.get("location")).toBe("/settings/account?linked=apple");
    expect(findByIdentity("apple", "a-9")?.username).toBe("ben");
  });

  it("passes on a way back it did not start", async () => {
    process.env.ACCOUNT_SIGNIN_SERVICE = SERVICE;
    const asked = service({ provider: "google", sub: "g-77" }, () => "");
    const res = await app.request("/api/auth/service/callback?state=not-ours&ticket=T1");
    expect([400, 401, 404]).toContain(res.status);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(asked).toEqual([]);
  });
});
