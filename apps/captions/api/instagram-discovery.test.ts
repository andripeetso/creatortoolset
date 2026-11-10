import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

// Another creator's professional account in the Analyzer, read through Meta's Business Discovery on the person's own
// Instagram login: no Apify key, the official API, the person's token (never the install's).
const dataDir = mkdtempSync(path.join(tmpdir(), "ig-discovery-"));
process.env.DATA_DIR = dataDir;
process.env.INSTAGRAM_BUSINESS_DISCOVERY = "1";

const asked: string[] = [];
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string | URL) => {
    const u = new URL(String(url));
    asked.push(u.toString());
    if (u.hostname === "graph.facebook.com" && u.pathname.endsWith("/ig1") && (u.searchParams.get("fields") ?? "").startsWith("business_discovery.username(tinyhomes)"))
      return Response.json({
        business_discovery: {
          id: "17841",
          username: "tinyhomes",
          name: "Tiny Homes",
          followers_count: 5200,
          media_count: 40,
          media: { data: [{ id: "m1", caption: "A tiny kitchen", like_count: 300, comments_count: 12, media_type: "VIDEO", permalink: "https://www.instagram.com/reel/ABCDE12345/", timestamp: "2026-11-01T10:00:00+0000" }] },
        },
      });
    throw new TypeError("fetch failed");
  }),
);

const { saveAccounts } = await import("./lib/connectors/store");
saveAccounts("test", [{ platform: "instagram", platformId: "ig1", handle: "tinyacrobatics", via: "login", token: "person-token", loginStatus: "connected" }]);
const { instagramApp } = await import("./instagram");
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "test", role: "user", cloud: true, off: [] });
  await next();
});
app.route("/", instagramApp);

it("adds and reads another professional account through Business Discovery, with no Apify key", async () => {
  const res = await app.request("/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "@tinyhomes", run: "now" }) });
  expect(res.status).toBe(202);
  const { id } = (await res.json()) as { id: string };
  const meta = () => JSON.parse(readFileSync(path.join(dataDir, "instagram", "accounts", id, "meta.json"), "utf-8"));
  await vi.waitFor(() => expect(meta().status).toBe("ready"), { timeout: 10_000 });
  expect(meta().counts).toMatchObject({ followers: 5200, posts: 40 });
  const catalog = JSON.parse(readFileSync(path.join(dataDir, "instagram", "accounts", id, "catalog.json"), "utf-8"));
  expect(JSON.stringify(catalog)).toContain("ABCDE12345");
  const graph = asked.filter((u) => u.includes("graph.facebook.com"));
  expect(graph.length).toBeGreaterThan(0);
  expect(graph.every((u) => new URL(u).searchParams.get("access_token") === "person-token")).toBe(true);
});
