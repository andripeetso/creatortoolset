import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Settings → Connectors: each person's own logins and handles. Network mocked.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "connectors-"));
process.env.META_APP_ID = "app";
process.env.META_APP_SECRET = "secret";

const { Hono } = await import("hono");
const { connectorsApp, channelFiles } = await import("./connectors");
const { readConnectors } = await import("./lib/connectors/store");
const { graphCredsFor } = await import("./lib/instagram/graph");
const { apifyPost } = await import("./lib/connectors/platforms");

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "ana", role: "user", cloud: true, off: [] });
  await next();
});
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

  it("an admin's pasted app keys win over the env, Meta can log in by configuration, TikTok's check file is served", async () => {
    const admin = new Hono<{ Variables: { user: unknown } }>();
    admin.use("*", async (c, next) => {
      c.set("user", { username: "boss", role: "admin", cloud: true, off: [] });
      await next();
    });
    admin.route("/api/connectors", connectorsApp as never);
    const put = (body: unknown, a = admin) => a.request("/api/connectors/apps", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await put({ kind: "meta", id: "123" }, app as never)).status).toBe(403);
    expect((await put({ kind: "meta", id: "999", secret: "s3", configId: "cfg7" })).status).toBe(200);
    const login = new URL((await admin.request("/api/connectors/login/meta")).headers.get("location")!);
    expect(login.searchParams.get("client_id")).toBe("999");
    expect(login.searchParams.get("config_id")).toBe("cfg7");
    expect(login.searchParams.get("scope")).toBeNull();
    const shown = await (await admin.request("/api/connectors/apps")).text();
    expect(shown).toContain("999");
    expect(shown).not.toContain("s3");
    expect((await put({ kind: "tiktokVerify", name: "../etc.txt", content: "x" })).status).toBe(400);
    expect((await put({ kind: "tiktokVerify", name: "tiktokAbC.txt", content: "tiktok-developers-site-verification=abc" })).status).toBe(200);
    const { tiktokVerifyFile } = await import("./connectors");
    expect(tiktokVerifyFile("tiktokAbC.txt")).toBe("tiktok-developers-site-verification=abc");
    expect(tiktokVerifyFile("tiktokOther.txt")).toBeNull();
  });
});

