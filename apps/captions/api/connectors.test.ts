import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Settings → Connectors: each person's own logins and handles. Network mocked.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "connectors-"));
process.env.META_APP_ID = "app";
process.env.META_APP_SECRET = "secret";

const { Hono } = await import("hono");
const { connectorsApp, connectorsCallbackApp, channelFiles } = await import("./connectors");
const { readConnectors } = await import("./lib/connectors/store");
const { graphCredsFor } = await import("./lib/instagram/graph");
const { apifyPost } = await import("./lib/connectors/platforms");

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "ana", role: "user", cloud: true, off: [] });
  await next();
});
app.route("/api/connectors", connectorsCallbackApp as never);
app.route("/api/connectors", connectorsApp as never);

afterEach(() => vi.unstubAllGlobals());

describe("connectors", () => {
  it("a Meta login keeps each Page and its Instagram with their own token; the Analyzer pulls that Instagram on it, never on the install's", async () => {
    const start = await app.request("/api/connectors/login/meta?back=/settings/connectors");
    const to = new URL(start.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://www.facebook.com/v27.0/dialog/oauth");
    expect(to.searchParams.get("scope")).toContain("instagram_manage_insights");
    const state = to.searchParams.get("state")!;

    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("fb_exchange_token")) return Response.json({ access_token: "long" });
      if (u.includes("/oauth/access_token")) return Response.json({ access_token: "short" });
      if (u.includes("/me/accounts"))
        return Response.json({ data: [{ id: "p1", name: "Tiny Acrobatics", access_token: "page-token", instagram_business_account: { id: "ig1", username: "tinyacrobatics", followers_count: 900 } }] });
      return Response.json({ data: [] });
    });
    const done = await app.request(`/api/connectors/callback/meta?state=${state}&code=abc`);
    expect(done.headers.get("location")).toBe("/settings/connectors?connected=2");
    const accounts = readConnectors("ana").accounts;
    expect(accounts.map((a) => [a.key, a.token])).toEqual([
      ["facebook:p1", "page-token"],
      ["instagram:ig1", "page-token"],
    ]);
    expect(graphCredsFor({ owner: "ana", username: "TinyAcrobatics" })).toEqual({ token: "page-token", userId: "ig1" });
    expect(graphCredsFor({ owner: "ana", username: "other", mine: true })).toBeNull();
    // a replayed or foreign state is refused
    expect((await app.request(`/api/connectors/callback/meta?state=${state}&code=abc`)).headers.get("location")).toContain("error=");
    const view = (await (await app.request("/api/connectors")).json()) as { accounts: Array<Record<string, unknown>> };
    expect(JSON.stringify(view)).not.toContain("page-token");
  });

  it("a handle is read on the user's own Apify and its posts reach its project's Workshop folder", async () => {
    expect(apifyPost("tiktok", { id: "7", webVideoUrl: "https://t/7", createTimeISO: "2026-11-01T00:00:00Z", text: "crawl", playCount: 1200, diggCount: 80 })).toMatchObject({ views: 1200, likes: 80 });
    const r = await app.request("/api/connectors/handles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: "tiktok", handle: "https://www.tiktok.com/@TinyAcrobatics", projectId: "proj-1" }) });
    expect(r.status).toBe(201);
    const key = "tiktok:tinyacrobatics";
    const { patchAccount } = await import("./lib/connectors/store");
    patchAccount("ana", key, { posts: [{ id: "7", at: Date.parse("2026-11-01"), text: "crawl | tips", views: 1200 }], stats: { followers: 5000 } });
    const files = channelFiles("ana", "proj-1");
    expect(files["channels/tiktok-TinyAcrobatics.md"]).toContain("5,000 followers");
    expect(files["channels/tiktok-TinyAcrobatics.md"]).toContain("| 2026-11-01 | 1200 |");
    expect(channelFiles("ana", "proj-2")).toEqual({});
  });

  it("the apps come from the env only; a Business Meta app logs in by its configuration", async () => {
    // names only: which logins this server is set up for, never the keys
    const apps = (await (await app.request("/api/connectors/apps")).json()) as { set: Record<string, boolean> };
    expect(apps).toEqual({ set: { meta: true, google: false, tiktok: false } });
    expect(JSON.stringify(apps)).not.toContain("secret");
    vi.stubEnv("META_CONFIG_ID", "cfg7");
    try {
      const login = new URL((await app.request("/api/connectors/login/meta")).headers.get("location")!);
      expect(login.searchParams.get("client_id")).toBe("app");
      expect(login.searchParams.get("config_id")).toBe("cfg7");
      expect(login.searchParams.get("scope")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a Business Meta app set with META_LOGIN_CONFIG_ID logs in by the same configuration; META_CONFIG_ID wins when both are set", async () => {
    vi.stubEnv("META_CONFIG_ID", "");
    vi.stubEnv("META_LOGIN_CONFIG_ID", "cfg8");
    try {
      const login = new URL((await app.request("/api/connectors/login/meta")).headers.get("location")!);
      expect(login.searchParams.get("config_id")).toBe("cfg8");
    } finally {
      vi.unstubAllEnvs();
    }
    vi.stubEnv("META_CONFIG_ID", "cfg7");
    vi.stubEnv("META_LOGIN_CONFIG_ID", "cfg8");
    try {
      const login = new URL((await app.request("/api/connectors/login/meta")).headers.get("location")!);
      expect(login.searchParams.get("config_id")).toBe("cfg7");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("serves the TikTok verify file only under the name and content in .env", async () => {
    const { tiktokVerifyFile } = await import("./connectors");
    vi.stubEnv("TIKTOK_VERIFY_FILE", "tiktokAbC.txt");
    vi.stubEnv("TIKTOK_VERIFY_CONTENT", "tiktok-developers-site-verification=abc");
    try {
      expect(tiktokVerifyFile("tiktokAbC.txt")).toBe("tiktok-developers-site-verification=abc");
      expect(tiktokVerifyFile("tiktokOther.txt")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(tiktokVerifyFile("tiktokAbC.txt")).toBeNull();
  });
});


describe("the sign-in service", () => {
  it("an install with no app of its own signs in through the service: the ticket pays out to its verifier, and the login renews there", async () => {
    const { createHash } = await import("node:crypto");
    const { forgetServiceLogins, serviceRefresh } = await import("./lib/connectors/signin-service");
    const { freshToken } = await import("./lib/connectors/platforms");
    process.env.PLATFORM_SIGNIN_ORIGIN = "https://svc.test";
    forgetServiceLogins();
    let challenge = "";
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      asked.push(u);
      if (u === "https://svc.test/api/platform-signin") return Response.json({ meta: true, google: true, tiktok: false });
      if (u === "https://svc.test/api/platform-signin/redeem") {
        const { ticket, verifier } = JSON.parse(String(init?.body)) as { ticket: string; verifier: string };
        const ok = ticket === "T1" && createHash("sha256").update(verifier).digest("base64url") === challenge;
        return ok ? Response.json({ access_token: "t1", refresh_token: "r1", expires_in: 60 }) : Response.json({ error: "no" }, { status: 403 });
      }
      if (u === "https://svc.test/api/platform-signin/refresh") return Response.json({ access_token: "t2", expires_in: 3600 });
      if (u.includes("youtube/v3/channels")) return Response.json({ items: [{ id: "UC1", snippet: { title: "Tiny Acrobatics", customUrl: "@tinyacrobatics" } }] });
      return Response.json({}, { status: 404 });
    });
    try {
      // Meta has its app here (META_APP_ID above): that one stays local; YouTube comes from the service
      const view = (await (await app.request("/api/connectors")).json()) as { logins: Record<string, boolean> };
      expect(view.logins).toEqual({ meta: true, google: true, tiktok: false });
      expect((await app.request("/api/connectors/login/meta")).headers.get("location")).toContain("facebook.com");

      const start = new URL((await app.request("/api/connectors/login/google")).headers.get("location")!);
      expect(start.origin + start.pathname).toBe("https://svc.test/api/platform-signin/start/google");
      expect(start.searchParams.get("return")).toBe("http://localhost/api/connectors/callback/google");
      challenge = start.searchParams.get("challenge")!;
      const state = start.searchParams.get("state")!;

      const done = await app.request(`/api/connectors/callback/google?state=${state}&ticket=T1`);
      expect(done.headers.get("location")).toBe("/settings/connectors?connected=1");
      const yt = readConnectors("ana").accounts.find((a) => a.platform === "youtube")!;
      expect(yt).toMatchObject({ handle: "tinyacrobatics", token: "t1", refresh: "r1", issuer: "service" });
      // no tokens in any address the browser saw
      expect(asked.join(" ")).not.toContain("t1");

      // a renewal of a service login goes back to the service
      expect(await freshToken({ ...yt, expiresAt: Date.now() }, serviceRefresh)).toMatchObject({ token: "t2", refresh: "r1" });

      // a ticket the service refuses (another install's verifier) ends as an error, not an account
      const again = new URL((await app.request("/api/connectors/login/google")).headers.get("location")!);
      challenge = "someone-else";
      expect((await app.request(`/api/connectors/callback/google?state=${again.searchParams.get("state")}&ticket=T1`)).headers.get("location")).toContain("error=");
    } finally {
      delete process.env.PLATFORM_SIGNIN_ORIGIN;
      forgetServiceLogins();
    }
  });

  it("an offline service hides its sign-ins and is asked again only after a minute", async () => {
    const { forgetServiceLogins, loginsOn } = await import("./lib/connectors/signin-service");
    process.env.PLATFORM_SIGNIN_ORIGIN = "https://svc.test";
    forgetServiceLogins();
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      throw new Error("offline");
    });
    try {
      expect(await loginsOn()).toEqual({ meta: true, google: false, tiktok: false });
      await loginsOn();
      expect(n).toBe(1);
    } finally {
      delete process.env.PLATFORM_SIGNIN_ORIGIN;
      forgetServiceLogins();
    }
  });
});
