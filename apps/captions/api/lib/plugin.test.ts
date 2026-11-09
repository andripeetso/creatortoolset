import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { definePlugin, driverKinds, mountAdminRoutes, mountPlugins, mountReplacedRoutes, providerPresets } from "./plugin";

describe("mountPlugins", () => {
  it("serves a plug-in's routes under /api/x/<id>", async () => {
    const app = new Hono();
    const routes = new Hono().get("/ping", (c) => c.json({ ok: true }));
    mountPlugins(app, [definePlugin({ id: "tiny", routes })]);
    const res = await app.request("/api/x/tiny/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("refuses a plug-in whose path is already served", () => {
    const app = new Hono();
    app.get("/api/x/tiny/ping", (c) => c.text("built in"));
    const routes = new Hono().get("/ping", (c) => c.text("plug-in"));
    expect(() => mountPlugins(app, [definePlugin({ id: "tiny", routes })])).toThrow("already served");
  });

  it("refuses an edit flag id that two plug-ins both declare, or one that is not lowercase words", () => {
    const app = new Hono();
    const a = definePlugin({ id: "tiny-a", editFlags: [{ id: "tiny-flag", label: "A" }] });
    const b = definePlugin({ id: "tiny-b", editFlags: [{ id: "tiny-flag", label: "B" }] });
    expect(() => mountPlugins(app, [a, b])).toThrow("declared twice");
    expect(() => mountPlugins(app, [definePlugin({ id: "tiny-c", editFlags: [{ id: "Tiny Flag", label: "C" }] })])).toThrow("lowercase words");
  });
});

describe("mountPlugins: provider kinds and presets", () => {
  it("lists a plug-in's driver kind and preset, and refuses a kind that is a built-in driver or a preset with an unknown driver", () => {
    const app = new Hono();
    mountPlugins(app, [
      definePlugin({
        id: "tiny-kind",
        providers: { kinds: [{ id: "tinycli", label: "Tiny CLI", featured: false }], presets: [{ id: "tiny-hub", name: "Tiny (hub)", driver: "tinycli", badge: "Custom API endpoint" }] },
      }),
    ]);
    expect(driverKinds()).toEqual([{ id: "tinycli", label: "Tiny CLI", featured: false }]);
    expect(providerPresets().map((p) => p.id)).toEqual(["tiny-hub"]);
    expect(() => mountPlugins(app, [definePlugin({ id: "tiny-builtin", providers: { kinds: [{ id: "claude", label: "X", featured: false }] } })])).toThrow("already a driver");
    expect(() => mountPlugins(app, [definePlugin({ id: "tiny-bad", providers: { presets: [{ id: "tiny-x", name: "X", driver: "nope", badge: "b" }] } })])).toThrow("unknown driver");
  });
});

describe("mountReplacedRoutes", () => {
  const builtIn = () => new Hono().post("/worker/heartbeat", (c) => c.text("built-in"));

  it("answers a replaced root path with the plug-in, ahead of the built-in router", async () => {
    const app = new Hono();
    const routes = new Hono().post("/worker/heartbeat", (c) => c.text("plug-in"));
    mountReplacedRoutes(app, [definePlugin({ id: "tiny", replaces: { paths: ["/api/editor"], routes } })]);
    app.route("/api/editor", builtIn());
    const res = await app.request("/api/editor/worker/heartbeat", { method: "POST" });
    expect(await res.text()).toBe("plug-in");
  });

  it("without a plug-in that replaces it, the built-in router answers the root path", async () => {
    const app = new Hono();
    mountReplacedRoutes(app, [definePlugin({ id: "tiny" })]);
    app.route("/api/editor", builtIn());
    expect(await (await app.request("/api/editor/worker/heartbeat", { method: "POST" })).text()).toBe("built-in");
  });

  it("refuses a replaced path that is not a replaceable built-in path", () => {
    const routes = new Hono();
    expect(() => mountReplacedRoutes(new Hono(), [definePlugin({ id: "tiny", replaces: { paths: ["/api/review"], routes } })])).toThrow(
      "not a replaceable path",
    );
  });

  it("refuses two plug-ins that replace the same path", () => {
    const routes = new Hono();
    const a = definePlugin({ id: "tiny-a", replaces: { paths: ["/api/editor"], routes } });
    const b = definePlugin({ id: "tiny-b", replaces: { paths: ["/api/editor"], routes } });
    expect(() => mountReplacedRoutes(new Hono(), [a, b])).toThrow("replaced by plug-ins");
  });
});

describe("mountAdminRoutes", () => {
  it("answers a plug-in's admin path under /api/admin, ahead of the built-in admin routes, which still answer their own paths", async () => {
    const app = new Hono();
    const routes = new Hono().get("/media-access", (c) => c.text("plug-in"));
    mountAdminRoutes(app, [definePlugin({ id: "tiny", adminRoutes: routes })]);
    app.route("/api/admin", new Hono().get("/users", (c) => c.text("built-in")).get("/media-access", (c) => c.text("built-in")));
    expect(await (await app.request("/api/admin/media-access")).text()).toBe("plug-in");
    expect(await (await app.request("/api/admin/users")).text()).toBe("built-in");
  });
});
