import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "plugin-gates-"));
process.env.APP_SECRET = "plugin-gates-test-secret";

const { definePlugin, mountPlugins, requireGate } = await import("./lib/plugin");
const { createUser, findUser, mayUse, setOff } = await import("./users");

// A test plug-in with one gate that is off for every new user account, and a route behind it.
const routes = new Hono().get("/ping", requireGate("tiny-footage"), (c) => c.json({ ok: true }));
const tiny = definePlugin({ id: "tiny", gates: { ids: ["tiny-footage"], defaultOff: ["tiny-footage"] }, routes });

// Stands in for the account gate: the account the request names (boot.ts sets this for real requests).
const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  const name = c.req.header("x-user");
  c.set("user", name ? findUser(name) : null);
  await next();
});
mountPlugins(app, [tiny]);

const status = async (who: string) => (await app.request("/api/x/tiny/ping", { headers: { "x-user": who } })).status;

describe("plug-in gates", () => {
  it("starts a new role-user account with every declared gate switched off", () => {
    const fresh = createUser("newuser", "password1");
    expect(fresh.off).toContain("tiny-footage");
    expect(mayUse(fresh, "tiny-footage")).toBe(false);
  });

  it("keeps the default off for a new role-user account only", () => {
    const admin = createUser("gate-admin", "password1", { role: "admin" });
    expect(admin.off).toEqual([]);
    expect(mayUse(admin, "tiny-footage")).toBe(true);
  });

  it("refuses a gated route with 403 while the gate is off, and admits it once on", async () => {
    createUser("gate-user", "password1");
    expect(await status("gate-user")).toBe(403);
    findUser("gate-user")!.off = [];
    expect(await status("gate-user")).toBe(200);
    expect(await status("gate-admin")).toBe(200);
  });

  it("refuses a request with no account", async () => {
    expect(await app.request("/api/x/tiny/ping")).toMatchObject({ status: 403 });
  });

  it("refuses a gate id that is a built-in app, or one declared by two plug-ins", () => {
    expect(() => mountPlugins(new Hono(), [definePlugin({ id: "bad", gates: { ids: ["media"] } })])).toThrow("not a gate id");
    expect(() =>
      mountPlugins(new Hono(), [
        definePlugin({ id: "one", gates: { ids: ["shared-gate"] } }),
        definePlugin({ id: "two", gates: { ids: ["shared-gate"] } }),
      ]),
    ).toThrow("declared by plug-ins");
  });

  it("refuses a retired app id as a gate, and an off list keeps its entry", () => {
    expect(() => mountPlugins(new Hono(), [definePlugin({ id: "old", gates: { ids: ["finals"] } })])).toThrow("not a gate id");
    const u = createUser("retired-user", "password1");
    setOff(u, ["finals", "media", "Not A Gate"]);
    expect(u.off).toEqual(["finals", "media"]);
  });
});
