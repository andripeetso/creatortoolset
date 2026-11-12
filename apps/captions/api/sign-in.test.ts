import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Sign in with Apple / Google / GitHub to a site account and linking one (sign-in.ts, users.ts, auth.ts), on a hosted server.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "sign-in-"));
process.env.APP_SECRET = "sign-in-test-secret";
process.env.CT_MODE = "hosted";
delete process.env.APPLE_SIGNIN_KEY;
delete process.env.GOOGLE_SIGNIN_CLIENT_ID;
delete process.env.GOOGLE_SIGNIN_CLIENT_SECRET;
delete process.env.GITHUB_CLIENT_ID;
delete process.env.GITHUB_CLIENT_SECRET;

const { createUser, findByIdentity, findUser, linkIdentity } = await import("./users");
const { githubIdentity, signinOn } = await import("./sign-in");
const app = (await import("./boot")).default;

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

describe("sign-in to a site account (hosted mode)", () => {
  it("offers Apple and Google only on the sign-in origin, with keys set", () => {
    expect(signinOn("https://creatortoolset.com")).toEqual({ apple: false, google: false, github: false });
    expect(signinOn("http://localhost")).toEqual({ apple: false, google: false, github: false });
  });

  it("says sign-in isn't set up when the server has no keys", async () => {
    const res = await app.request("/api/account/login/google?for=site");
    expect(res.status).toBe(501);
  });

  it("links only from a signed-in account", async () => {
    expect((await app.request("/api/account/login/google?for=link")).status).toBe(401);
  });

  it("keeps one account per provider identity", () => {
    createUser("ana", "anapass12", { role: "user" });
    createUser("ben", "benpass12", { role: "user" });
    linkIdentity(findUser("ana")!, { provider: "google", sub: "g-1", email: "ana@example.test" });
    expect(findByIdentity("google", "g-1")?.username).toBe("ana");
    expect(() => linkIdentity(findUser("ben")!, { provider: "google", sub: "g-1", email: "ana@example.test" })).toThrow(/already signs in/);
  });

  it("unlinks a provider for the signed-in account only", async () => {
    expect((await app.request("/api/auth/identity/google", { method: "DELETE" })).status).toBe(401);
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ana", password: "anapass12" }),
    });
    const cookie = cookieOf(login);
    const res = await app.request("/api/auth/identity/google", { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(findUser("ana")?.identities).toBeUndefined();
    expect(findByIdentity("google", "g-1")).toBeNull();
    expect((await app.request("/api/auth/identity/nope", { method: "DELETE", headers: { cookie } })).status).toBe(404);
  });

  it("passes a callback it did not start on (a 400 or 404 here, the Mac app's own answer when that is mounted)", async () => {
    const res = await app.request("/api/auth/google/callback?state=not-ours&code=x");
    expect([400, 404]).toContain(res.status);
  });
});

describe("GitHub sign-in (hosted mode, GitHub's endpoints faked)", () => {
  const CLIENT = "gh-client-test";
  const SECRET = "gh-secret-test";
  // what the fake GitHub says about the account's email addresses (each test sets its own)
  let emails: { email: string; primary: boolean; verified: boolean }[] = [];
  const fakeGitHub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      const good = body.client_id === CLIENT && body.client_secret === SECRET && body.code === "good-code" && headers.get("accept") === "application/json";
      return Response.json(good ? { access_token: "gho_test" } : { error: "bad_verification_code" });
    }
    if (url === "https://api.github.com/user") {
      if (headers.get("authorization") !== "Bearer gho_test" || !headers.get("user-agent")) return new Response("{}", { status: 401 });
      return Response.json({ id: 4242, login: "cy-gh", name: "Cy Tiny" });
    }
    if (url === "https://api.github.com/user/emails") return Response.json(emails);
    throw new Error(`unexpected request to ${url}`);
  };
  const CALLBACK = "http://localhost/api/auth/github/callback";

  beforeAll(() => {
    process.env.GITHUB_CLIENT_ID = CLIENT;
    process.env.GITHUB_CLIENT_SECRET = SECRET;
    process.env.SIGNIN_ORIGIN = "http://localhost";
    createUser("cy", "cypass123", { role: "user" });
  });
  afterAll(() => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.SIGNIN_ORIGIN;
  });
  beforeEach(() => {
    emails = [{ email: "cy@tinyacrobatics.com", primary: true, verified: true }];
    vi.spyOn(globalThis, "fetch").mockImplementation(fakeGitHub as typeof fetch);
  });

  it("offers GitHub only with its keys on the sign-in origin", () => {
    expect(signinOn("http://localhost")).toEqual({ apple: false, google: false, github: true });
    expect(signinOn("https://creatortoolset.com")).toEqual({ apple: false, google: false, github: false });
  });

  it("refuses a provider with no keys, and passes on a provider this server does not know", async () => {
    delete process.env.GITHUB_CLIENT_SECRET;
    expect((await app.request("/api/account/login/github?for=site")).status).toBe(501);
    process.env.GITHUB_CLIENT_SECRET = SECRET;
    // not a provider here: nothing starts a sign-in (the site's gate answers the unknown name first)
    const other = await app.request("/api/account/login/microsoft?for=site");
    expect([401, 404]).toContain(other.status);
    expect(other.headers.get("location")).toBeNull();
  });

  it("signs a linked GitHub account in through the start and the callback, once", async () => {
    linkIdentity(findUser("cy")!, { provider: "github", sub: "4242", email: "" });
    const start = await app.request("/api/account/login/github?for=site");
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe(CLIENT);
    expect(to.searchParams.get("redirect_uri")).toBe(CALLBACK);
    const state = to.searchParams.get("state")!;
    const back = await app.request(`/api/auth/github/callback?code=good-code&state=${state}`);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/");
    expect(cookieOf(back)).toMatch(/=/);
    expect(findByIdentity("github", "4242")?.username).toBe("cy");
    // the state is single use
    const again = await app.request(`/api/auth/github/callback?code=good-code&state=${state}`);
    expect([400, 404]).toContain(again.status);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("goes back to the page the person pressed sign in on, and never to another site", async () => {
    const via = async (next: string) => {
      const start = await app.request(`/api/account/login/github?for=site&next=${encodeURIComponent(next)}`);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      return (await app.request(`/api/auth/github/callback?code=good-code&state=${state}`)).headers.get("location");
    };
    expect(await via("/admin")).toBe("/admin");
    expect(await via("/review?x=1")).toBe("/review?x=1");
    for (const bad of ["https://evil.example/", "//evil.example/", "/\\evil.example", "/api/auth/logout", "admin"]) expect(await via(bad), bad).toBe("/");
  });

  it("shows the login screen only the sign-ins an account here has linked", async () => {
    // cy has GitHub linked (the test above); with no account on GitHub, the button would only ever fail
    expect(await (await app.request("/api/account/providers?login=1")).json()).toMatchObject({ apple: false, google: false, github: true });
    const { unlinkIdentity } = await import("./users");
    unlinkIdentity(findUser("cy")!, "github");
    expect(await (await app.request("/api/account/providers?login=1")).json()).toMatchObject({ apple: false, google: false, github: false });
    // Settings (linking another) still sees every provider with keys
    expect(await (await app.request("/api/account/providers")).json()).toEqual({ apple: false, google: false, github: true });
    linkIdentity(findUser("cy")!, { provider: "github", sub: "4242", email: "" });
  });

  it("refuses a state this server did not start, and a GitHub state sent to Google's callback", async () => {
    const bogus = await app.request("/api/auth/github/callback?code=good-code&state=not-ours");
    expect([400, 404]).toContain(bogus.status);
    expect(bogus.headers.get("set-cookie")).toBeNull();
    const start = await app.request("/api/account/login/github?for=site");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const crossed = await app.request(`/api/auth/google/callback?code=good-code&state=${state}`);
    expect(crossed.status).toBe(400);
    expect(crossed.headers.get("set-cookie")).toBeNull();
    // the crossed try used the state up: the right callback is refused too
    const late = await app.request(`/api/auth/github/callback?code=good-code&state=${state}`);
    expect([400, 404]).toContain(late.status);
    expect(late.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a code GitHub did not issue", async () => {
    const start = await app.request("/api/account/login/github?for=site");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await app.request(`/api/auth/github/callback?code=forged&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?error=");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a GitHub sign-in with no verified primary address, and signs no one in", async () => {
    emails = [{ email: "cy@tinyacrobatics.com", primary: true, verified: false }];
    await expect(githubIdentity("good-code", CALLBACK)).rejects.toThrow(/verified primary/);
    emails = [{ email: "other@tinyacrobatics.com", primary: false, verified: true }];
    await expect(githubIdentity("good-code", CALLBACK)).rejects.toThrow(/verified primary/);
    const start = await app.request("/api/account/login/github?for=site");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await app.request(`/api/auth/github/callback?code=good-code&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?error=");
    expect(res.headers.get("set-cookie")).toBeNull();
    emails = [{ email: "cy@tinyacrobatics.com", primary: true, verified: true }];
    expect((await githubIdentity("good-code", CALLBACK)).email).toBe("cy@tinyacrobatics.com");
  });

  it("finishes a GitHub link in the browser that started it; another browser is asked first, as Google's is", async () => {
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "cy", password: "cypass123" }),
    });
    const cookie = cookieOf(login);
    const start = await app.request("/api/account/login/github?for=link", { headers: { cookie } });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    // the same callback from a browser that is not signed in: a page naming the account, nothing linked without its press
    const other = await app.request(`/api/auth/github/callback?code=good-code&state=${state}`);
    expect(await other.text()).toContain("will sign in to <b>cy</b>");
    expect(other.headers.get("set-cookie")).toBeNull();
    // the browser that started it: linked
    const again = await app.request("/api/account/login/github?for=link", { headers: { cookie } });
    const state2 = new URL(again.headers.get("location")!).searchParams.get("state")!;
    const back = await app.request(`/api/auth/github/callback?code=good-code&state=${state2}`, { headers: { cookie } });
    expect(back.headers.get("location")).toBe("/settings/account?linked=github");
    expect(findByIdentity("github", "4242")?.username).toBe("cy");
  });

  it("unlinks a GitHub sign-in for the signed-in account", async () => {
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "cy", password: "cypass123" }),
    });
    const res = await app.request("/api/auth/identity/github", { method: "DELETE", headers: { cookie: cookieOf(login) } });
    expect(res.status).toBe(200);
    expect(findByIdentity("github", "4242")).toBeNull();
  });
});

describe("first sign-in (hosted mode, GitHub faked): refused unless the server opened sign-ups, then it makes the account", () => {
  // a new person: GitHub id 5151, not linked to anyone here yet
  const fakeGitHub = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_ada" });
    if (url === "https://api.github.com/user") return Response.json({ id: 5151, login: "ada-gh", name: "Ada Tiny" });
    if (url === "https://api.github.com/user/emails") return Response.json([{ email: "ada@tinyacrobatics.com", primary: true, verified: true }]);
    throw new Error(`unexpected request to ${url}`);
  };
  const signIn = async () => {
    const start = await app.request("/api/account/login/github?for=site");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    return app.request(`/api/auth/github/callback?code=good-code&state=${state}`);
  };

  beforeAll(() => {
    process.env.GITHUB_CLIENT_ID = "gh-client-first";
    process.env.GITHUB_CLIENT_SECRET = "gh-secret-first";
    process.env.SIGNIN_ORIGIN = "http://localhost";
  });
  afterAll(() => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.SIGNIN_ORIGIN;
    delete process.env.SIGN_UPS;
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(fakeGitHub as typeof fetch);
  });

  it("tells the login screen which providers have keys", async () => {
    expect(await (await app.request("/api/account/providers")).json()).toEqual({ apple: false, google: false, github: true });
  });

  it("makes no account and signs no one in while sign-ups are closed (the default)", async () => {
    const back = await signIn();
    expect(back.status).toBe(302);
    expect(decodeURIComponent(back.headers.get("location")!)).toMatch(/^\/login\?error=There is no account here for that sign-in/);
    expect(cookieOf(back)).toBe("");
    expect(findByIdentity("github", "5151")).toBeNull();
  });

  it("with SIGN_UPS=open, makes the account on the first sign-in, named from the person (a taken name takes the next)", async () => {
    process.env.SIGN_UPS = "open";
    createUser("ada-tiny", "adapass12", { role: "user" });
    const back = await signIn();
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/");
    expect(cookieOf(back)).toMatch(/=/);
    expect(findByIdentity("github", "5151")?.username).toBe("ada-tiny-2");
  });

  it("signs the same identity into that account next time, with no second account", async () => {
    const again = await signIn();
    expect(again.status).toBe(302);
    expect(findByIdentity("github", "5151")?.username).toBe("ada-tiny-2");
    expect(findUser("ada-tiny-3")).toBeNull();
  });
});
