import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A provider sign-in an app started (sign-in.ts `app=1`, auth.ts POST /api/auth/app): it ends on the app's own link
// with a one-time code and sets no cookie; the app swaps the code, with its verifier, for the session. GitHub is this
// server's own client here and Google goes through the sign-in service, so both ways are covered; both are faked.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "sign-in-app-"));
process.env.APP_SECRET = "sign-in-app-test-secret";
process.env.CT_MODE = "hosted";
process.env.GITHUB_CLIENT_ID = "gh-client-app";
process.env.GITHUB_CLIENT_SECRET = "gh-secret-app";
process.env.SIGNIN_ORIGIN = "http://localhost";
process.env.ACCOUNT_SIGNIN_SERVICE = "https://signin.test";
for (const k of ["APPLE_SIGNIN_KEY", "GOOGLE_SIGNIN_CLIENT_ID", "GOOGLE_SIGNIN_CLIENT_SECRET", "SIGN_UPS", "PUBLIC_ORIGIN"]) delete process.env[k];

const { createUser, findUser, linkIdentity, setPassword } = await import("./users");
const app = (await import("./boot")).default;

createUser("cy", "cypass123", { role: "user" });
linkIdentity(findUser("cy")!, { provider: "github", sub: "4242", email: "" });
createUser("ana", "anapass12", { role: "user" });
linkIdentity(findUser("ana")!, { provider: "google", sub: "g-77", email: "ana@example.test" });

const VERIFIER = "v".repeat(43);
const pkce = (v: string) => createHash("sha256").update(v).digest("base64url");
const APP = `app=1&challenge=${pkce(VERIFIER)}`;
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const redeem = (code: unknown, verifier: unknown = VERIFIER) =>
  app.request("/api/auth/app", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, verifier }) });
const REFUSED = { error: "That sign-in code is used or expired" };

/** The sign-in service's challenge for the sign-in in flight (its redeem pays out only to that verifier). */
let serviceChallenge = "";
/** Who the service says signed in. */
let serviceWho: Record<string, unknown> = {};
// GitHub: code "cy-code" is account 4242 (linked to cy), "stranger-code" is 9999 (nobody here); anything else is refused
const world = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url === "https://github.com/login/oauth/access_token") {
    const { code } = JSON.parse(String(init?.body)) as { code: string };
    return Response.json(code === "cy-code" ? { access_token: "gho_cy" } : code === "stranger-code" ? { access_token: "gho_stranger" } : { error: "bad_verification_code" });
  }
  const token = new Headers(init?.headers).get("authorization");
  if (url === "https://api.github.com/user") return Response.json(token === "Bearer gho_cy" ? { id: 4242, login: "cy-gh", name: "Cy Tiny" } : { id: 9999, login: "nobody-gh", name: "No Body" });
  if (url === "https://api.github.com/user/emails") return Response.json([{ email: "cy@tinyacrobatics.com", primary: true, verified: true }]);
  if (url === "https://signin.test/api/account-signin/redeem") {
    const { ticket, verifier } = JSON.parse(String(init?.body)) as { ticket: string; verifier: string };
    return ticket === "T1" && pkce(verifier) === serviceChallenge ? Response.json(serviceWho) : Response.json({ error: "no" }, { status: 403 });
  }
  throw new Error(`unexpected request to ${url}`);
};

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(world as typeof fetch);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** GitHub sign-in from a start address to the callback's answer. */
async function github(query: string, code = "cy-code") {
  const start = await app.request(`/api/account/login/github?${query}`);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  return app.request(`/api/auth/github/callback?code=${code}&state=${state}`);
}
/** The one-time code an app's sign-in ended with. */
const codeOf = (res: Response) => {
  const to = res.headers.get("location")!;
  expect(to).toMatch(/^creatortoolset:\/\/signin\?code=[A-Za-z0-9_-]{43}$/);
  return to.split("code=")[1]!;
};

describe("a sign-in an app started (for=site&app=1&challenge=…)", () => {
  it("ends on the app's link with a code and no cookie; the code and the verifier give the app its session, once", async () => {
    const back = await github(`for=site&${APP}`);
    expect(back.status).toBe(302);
    expect(back.headers.get("set-cookie")).toBeNull();
    const code = codeOf(back);
    expect(findUser("cy")!.usage.logins ?? 0).toBe(0); // nobody is signed in until the app collects

    const res = await redeem(code);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; user: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.user).toMatchObject({ username: "cy", name: "cy", role: "user" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(findUser("cy")!.usage.logins).toBe(1);

    // the cookie is the very one a browser's sign-in gets, and it is a working session
    const browser = await github("for=site");
    expect(browser.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toBe(browser.headers.get("set-cookie"));
    expect(res.headers.get("set-cookie")).toMatch(/^cap_auth=[^;]+; HttpOnly; Path=\/; Max-Age=\d+; SameSite=Lax$/);
    const check = (await (await app.request("/api/auth/check", { headers: { cookie: cookieOf(res) } })).json()) as { authed: boolean; user: { username: string } };
    expect(check.authed).toBe(true);
    expect(check.user.username).toBe("cy");

    // single use
    const again = await redeem(code);
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual(REFUSED);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a wrong verifier, and that try uses the code up", async () => {
    const code = codeOf(await github(`for=site&${APP}`));
    for (const wrong of ["x".repeat(43), "", "short", 7, pkce(VERIFIER)]) {
      const c = wrong === "x".repeat(43) ? code : codeOf(await github(`for=site&${APP}`));
      const res = await redeem(c, wrong);
      expect(res.status, String(wrong)).toBe(400);
      expect(await res.json()).toEqual(REFUSED);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    const late = await redeem(code);
    expect(late.status).toBe(400);
    expect(late.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a code after 60 seconds, a code nobody made, and a code whose account changed its password", async () => {
    const code = codeOf(await github(`for=site&${APP}`));
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    const expired = await redeem(code);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual(REFUSED);
    expect(expired.headers.get("set-cookie")).toBeNull();
    vi.mocked(Date.now).mockRestore();

    for (const made of ["not-a-code", "", null, {}]) {
      const res = await redeem(made);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(REFUSED);
    }
    expect((await app.request("/api/auth/app", { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json" })).status).toBe(400);

    // a form on another site can only send text: the right code and verifier sent that way sign no browser in
    const good = codeOf(await github(`for=site&${APP}`));
    const form = await app.request("/api/auth/app", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ code: good, verifier: VERIFIER }) });
    expect(form.status).toBe(400);
    expect(await form.json()).toEqual(REFUSED);
    expect(form.headers.get("set-cookie")).toBeNull();

    const stale = codeOf(await github(`for=site&${APP}`));
    setPassword(findUser("cy")!, "cy-new-pass-1");
    const res = await redeem(stale);
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("ends a failed sign-in on the app's link with the words the login screen would show", async () => {
    const browser = await github("for=site", "stranger-code");
    const words = browser.headers.get("location")!.replace(/^\/login\?error=/, "");
    expect(decodeURIComponent(words)).toMatch(/^There is no account here for that sign-in/);
    const stranger = await github(`for=site&${APP}`, "stranger-code");
    expect(stranger.status).toBe(302);
    expect(stranger.headers.get("location")).toBe(`creatortoolset://signin?error=${words}`);
    expect(stranger.headers.get("set-cookie")).toBeNull();

    const forged = await github(`for=site&${APP}`, "forged");
    expect(forged.headers.get("location")).toBe("creatortoolset://signin?error=Sign-in%20failed");
    expect(forged.headers.get("set-cookie")).toBeNull();

    const start = await app.request(`/api/account/login/github?for=site&${APP}`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cancelled = await app.request(`/api/auth/github/callback?error=access_denied&state=${state}`);
    expect(cancelled.headers.get("location")).toBe("creatortoolset://signin?error=Sign-in%20was%20cancelled");
  });

  it("answers an empty body 400, never 404: an app asks this way whether the server can do it at all", async () => {
    for (const init of [
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "" },
      { method: "POST" },
    ]) {
      const res = await app.request("/api/auth/app", init);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(REFUSED);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("starts nothing without a challenge, and never falls back to a browser's sign-in", async () => {
    for (const q of ["for=site&app=1", "for=site&app=1&challenge=short", `for=site&app=1&challenge=${"a".repeat(44)}`, "for=site&app=1&challenge=" + encodeURIComponent("+".repeat(43))]) {
      const res = await app.request(`/api/account/login/github?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toEqual({ error: "The app's sign-in challenge is missing" });
    }
    // `app` without `for=site` is the Mac app's own sign-in: a hosted plug-in answers that path (when mounted), and
    // this module must not have started it. A redirect here is fine only if its state is not one this module kept.
    const other = await app.request(`/api/account/login/github?${APP}`);
    const otherState = new URL(other.headers.get("location") ?? "http://none.test/").searchParams.get("state");
    const kept = otherState ? (JSON.parse(readFileSync(path.join(process.env.DATA_DIR!, "sign-ins-in-progress.json"), "utf8")) as Record<string, unknown>) : {};
    expect(otherState ? kept[otherState] : undefined).toBeUndefined();
  });

  it("works through the sign-in service too: the app's challenge stays here, and the code comes from this server", async () => {
    const start = await app.request(`/api/account/login/google?for=site&${APP}`);
    const to = new URL(start.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe("https://signin.test/api/account-signin/start/google");
    // the service gets this server's own challenge, never the app's, and no sign of the app
    expect(to.searchParams.get("challenge")).not.toBe(pkce(VERIFIER));
    expect([...to.searchParams.keys()].sort()).toEqual(["challenge", "return", "state"]);
    serviceChallenge = to.searchParams.get("challenge")!;
    serviceWho = { provider: "google", sub: "g-77", email: "ana@example.test", name: "Ana" };
    const back = await app.request(`/api/auth/service/callback?state=${to.searchParams.get("state")}&ticket=T1`);
    expect(back.headers.get("set-cookie")).toBeNull();
    const res = await redeem(codeOf(back));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { username: string } }).user.username).toBe("ana");
    expect(cookieOf(res)).toMatch(/^cap_auth=/);

    // the service sends the person back with a reason, or vouches for someone with no account here
    const second = new URL((await app.request(`/api/account/login/google?for=site&${APP}`)).headers.get("location")!);
    const cancelled = await app.request(`/api/auth/service/callback?state=${second.searchParams.get("state")}&error=${encodeURIComponent("Sign-in was cancelled")}`);
    expect(cancelled.headers.get("location")).toBe("creatortoolset://signin?error=Sign-in%20was%20cancelled");
    const third = new URL((await app.request(`/api/account/login/google?for=site&${APP}`)).headers.get("location")!);
    serviceChallenge = third.searchParams.get("challenge")!;
    serviceWho = { provider: "google", sub: "g-stranger", email: "x@example.test", name: "X" };
    const stranger = await app.request(`/api/auth/service/callback?state=${third.searchParams.get("state")}&ticket=T1`);
    expect(stranger.headers.get("location")).toMatch(/^creatortoolset:\/\/signin\?error=There%20is%20no%20account%20here/);
    expect(stranger.headers.get("set-cookie")).toBeNull();
  });
});

describe("a browser's sign-in (for=site, no app) is what it was", () => {
  const kept = () => JSON.parse(readFileSync(path.join(process.env.DATA_DIR!, "sign-ins-in-progress.json"), "utf8")) as Record<string, Record<string, unknown>>;

  it("keeps the same record of the sign-in in flight, sets the cookie and goes home", async () => {
    const start = await app.request("/api/account/login/github?for=site");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const entry = kept()[state]!;
    expect(Object.keys(entry).sort()).toEqual(["at", "kind", "mode"]);
    expect(entry.mode).toEqual({ type: "site" });
    const back = await app.request(`/api/auth/github/callback?code=cy-code&state=${state}`);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/");
    expect(cookieOf(back)).toMatch(/^cap_auth=/);
    expect(await back.text()).toBe("");
    // and an app's sign-in is told apart only by its own record
    const appStart = await app.request(`/api/account/login/github?for=site&${APP}`);
    const appState = new URL(appStart.headers.get("location")!).searchParams.get("state")!;
    expect(kept()[appState]!.mode).toEqual({ type: "site", app: pkce(VERIFIER) });
    expect(appStart.headers.get("location")!.replace(appState, "S")).toBe(start.headers.get("location")!.replace(state, "S"));
  });

  it("goes to the login screen when it fails, as before", async () => {
    const stranger = await github("for=site", "stranger-code");
    expect(stranger.headers.get("location")).toMatch(/^\/login\?error=There%20is%20no%20account%20here/);
    expect((await github("for=site", "forged")).headers.get("location")).toBe("/login?error=Sign-in%20failed");
  });
});
