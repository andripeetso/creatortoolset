import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountGatedRoutes, mountPublicRoutes, pluginBodyLimitExempt, startPlugins, type ServerPlugin } from "./lib/plugin";

// The plug-in host's route hooks: public routes before the account gate, gated routes after it, a start hook and the
// body-size exemption. A fake plug-in, so the real registry is not needed.
const gate = (app: Hono) =>
  app.use("/api/*", async (c, next) => (c.req.header("x-test-signed-in") ? next() : c.json({ error: "gate" }, 401)));

describe("plug-in route hooks", () => {
  it("answers a public route signed out, and holds a gated route behind the gate", async () => {
    const page = new Hono().get("/", (c) => c.text("site"));
    const feed = new Hono().get("/", (c) => c.text("feed"));
    const plugin: ServerPlugin = {
      id: "site-test",
      publicRoutes: [{ path: "/", app: page }, { path: "/api/feed", app: feed }],
      gatedRoutes: [{ path: "/api/private", app: new Hono().get("/", (c) => c.text("mine")) }],
    };
    const app = new Hono();
    mountPublicRoutes(app, [plugin]);
    gate(app);
    mountGatedRoutes(app, [plugin]);
    expect(await (await app.request("/")).text()).toBe("site");
    expect((await app.request("/api/feed")).status).toBe(200);
    expect((await app.request("/api/private")).status).toBe(401);
    expect((await app.request("/api/private", { headers: { "x-test-signed-in": "1" } })).status).toBe(200);
  });

  it("refuses a route path that is not absolute", () => {
    const bad: ServerPlugin = { id: "bad-test", publicRoutes: [{ path: "api/x", app: new Hono() }] };
    expect(() => mountPublicRoutes(new Hono(), [bad])).toThrow(/must start with \//);
  });

  it("starts each plug-in's start hook once, in load order", () => {
    const order: string[] = [];
    startPlugins([
      { id: "one-test", start: () => order.push("one") },
      { id: "two-test" },
      { id: "three-test", start: () => order.push("three") },
    ]);
    expect(order).toEqual(["one", "three"]);
  });

  it("lets a plug-in's route take a body past the cap only for the requests it names", () => {
    const plugins: ServerPlugin[] = [
      { id: "upload-test", bodyLimitExempt: (method, path) => method === "PUT" && path === "/api/release" },
    ];
    expect(pluginBodyLimitExempt(plugins, "PUT", "/api/release")).toBe(true);
    expect(pluginBodyLimitExempt(plugins, "POST", "/api/release")).toBe(false);
    expect(pluginBodyLimitExempt([], "PUT", "/api/release")).toBe(false);
  });
});
