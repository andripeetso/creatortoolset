import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AuthVars } from "./auth";

const dataDir = mkdtempSync(path.join(tmpdir(), "ig-avatar-"));
process.env.DATA_DIR = dataDir;

const { instagramApp } = await import("./instagram");

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "test", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/", instagramApp);

const ID = "acct01-avatar-fixture";

describe("GET /accounts/:id/avatar", () => {
  it("returns 200 after a fake file on disk", async () => {
    const dir = path.join(dataDir, "instagram", "accounts", ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        id: ID,
        igUserId: "",
        username: "fixture",
        owner: "test",
        tags: [],
        counts: { fetchedAt: 0 },
        status: "ready",
        progress: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    writeFileSync(path.join(dir, "avatar.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const res = await app.request(`/accounts/${ID}/avatar`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await res.arrayBuffer()).length).toBeGreaterThan(0);
  });

  it("returns 404 when the account has no cached photo", async () => {
    const res = await app.request("/accounts/acct02-missing-avatar/avatar");
    expect(res.status).toBe(404);
  });
});
