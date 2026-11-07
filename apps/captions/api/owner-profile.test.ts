import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "owner-profile-"));
const { ownerProfileApp } = await import("./owner-profile");
import type { AuthVars } from "./auth";
import type { SessionUser } from "./users";

let who: SessionUser = { username: "admin", role: "admin", cloud: true, off: [] };
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", who);
  await next();
});
app.route("/api/owner-profile", ownerProfileApp);
const post = (body: unknown) =>
  app.request("/api/owner-profile", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("the owner's profile from the Mac app's sign-in", () => {
  it("keeps the name and email an admin sends, refuses bad ones and anyone else", async () => {
    expect(await (await app.request("/api/owner-profile")).json()).toBeNull();
    expect((await post({ name: "Sam", email: "not an email" })).status).toBe(400);
    expect((await post({ name: "Sam Tiny", email: "sam@tinyacrobatics.com" })).status).toBe(200);
    expect((await post({ name: "", email: "x1@privaterelay.example.com" })).status).toBe(200);   // Apple: no name, relay address
    expect(await (await app.request("/api/owner-profile")).json()).toMatchObject({ name: "", email: "x1@privaterelay.example.com" });
    who = { username: "jordan", role: "user", cloud: true, off: [] };
    expect((await app.request("/api/owner-profile")).status).toBe(403);
    expect((await post({ name: "J", email: "j@example.com" })).status).toBe(403);
  });
});
