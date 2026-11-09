import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { definePlugin } from "./lib/plugin";
import { activityApp, appTools, pluginActivity, pluginMenu, type ActivityRow, type ActivityState } from "./activity";
import type { SessionUser } from "./users";

const admin: SessionUser = { username: "tiny", role: "admin", cloud: true, off: [] };
const row = (id: string, state: ActivityState = "working", href = "/editor"): ActivityRow => ({ id, title: `Row ${id}`, detail: "Tiny", state, href });

describe("pluginActivity", () => {
  it("prefixes each row's id with its plug-in and keeps only well-formed rows", async () => {
    const plugins = [definePlugin({ id: "tiny", activity: () => [row("a"), row("b", "ready", "/editor/b"), { ...row("bad"), state: "busy" as ActivityState }] })];
    const rows = await pluginActivity(plugins, admin);
    expect(rows.map((r) => r.id)).toEqual(["tiny:a", "tiny:b"]);
  });

  it("refuses hrefs that leave the app", async () => {
    const plugins = [definePlugin({ id: "tiny", activity: () => [row("a", "working", "https://example.com"), row("b", "working", "//example.com"), row("c", "working", "/\\example.com")] })];
    expect(await pluginActivity(plugins, admin)).toEqual([]);
  });

  it("adds nothing from a plug-in whose gate the account has switched off, admins excepted", async () => {
    const plugins = [definePlugin({ id: "tiny", gates: { ids: ["tiny-gate"] }, activity: () => [row("a")] })];
    const member: SessionUser = { ...admin, role: "user", off: ["tiny-gate"] };
    expect(await pluginActivity(plugins, member)).toEqual([]);
    expect((await pluginActivity(plugins, { ...member, off: [] })).map((r) => r.id)).toEqual(["tiny:a"]);
    expect((await pluginActivity(plugins, { ...member, role: "admin" })).map((r) => r.id)).toEqual(["tiny:a"]);
  });

  it("keeps a row's buttons only for a LaunchAgent label the plug-in declares", async () => {
    const start = { id: "start", title: "Start", run: "start" as const, label: "tiny.agent" };
    const plugins = [definePlugin({ id: "tiny", launchAgents: ["tiny.agent"], activity: () => [
      { ...row("a"), actions: [start, { ...start, id: "other", label: "com.apple.evil" }, { ...start, id: "bad", run: "delete" as never }] },
      { ...row("b"), actions: [{ ...start, id: "x", label: "com.apple.evil" }] },
      row("c"),
    ] })];
    const rows = await pluginActivity(plugins, admin);
    expect(rows.map((r) => r.id)).toEqual(["tiny:a", "tiny:b", "tiny:c"]);
    expect(rows[0].actions).toEqual([start]);
    expect(rows[1].actions).toBeUndefined();
    expect(rows[2].actions).toBeUndefined();
  });

  it("gives visitors nothing and skips a plug-in that throws or hangs", async () => {
    const plugins = [
      definePlugin({ id: "boom", activity: () => { throw new Error("no"); } }),
      definePlugin({ id: "slow", activity: () => new Promise<never>(() => {}) }),
      definePlugin({ id: "ok", activity: () => [row("a")] }),
    ];
    expect((await pluginActivity(plugins, admin, 20)).map((r) => r.id)).toEqual(["ok:a"]);
    const visitor: SessionUser = { ...admin, username: "visitor", role: "visitor" };
    expect(await pluginActivity(plugins, visitor, 20)).toEqual([]);
  });
});

describe("GET /api/activity", () => {
  it("answers the signed-in account's rows as JSON", async () => {
    const app = new Hono<any>();
    app.use("*", async (c, next) => { c.set("user", admin); await next(); });
    app.route("/api/activity", activityApp([definePlugin({ id: "tiny", activity: () => [row("a")] })]));
    const res = await app.request("/api/activity");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "tiny:a", title: "Row a", detail: "Tiny", state: "working", href: "/editor" }]);
  });
});

describe("pluginMenu and GET /api/activity/menu", () => {
  const item = (id: string, href = "/tiny") => ({ id, title: `Item ${id}`, href });

  it("prefixes ids, keeps well-formed app-path items, and drops the rest", async () => {
    const plugins = [definePlugin({ id: "tiny", menu: () => [
      item("a"),
      { ...item("b"), href: "https://example.com" },
      { ...item("c"), href: "//example.com" },
      { ...item("d"), title: "  " },
    ] })];
    expect(await pluginMenu(plugins, admin)).toEqual([{ id: "tiny:a", title: "Item a", href: "/tiny" }]);
  });

  it("follows the same gate as the rows: a switched-off gate adds nothing, admins excepted", async () => {
    const plugins = [definePlugin({ id: "tiny", gates: { ids: ["tiny-gate"] }, menu: () => [item("a")] })];
    const member: SessionUser = { ...admin, role: "user", off: ["tiny-gate"] };
    expect(await pluginMenu(plugins, member)).toEqual([]);
    expect((await pluginMenu(plugins, { ...member, role: "admin" })).map((i) => i.id)).toEqual(["tiny:a"]);
  });

  it("gives visitors nothing and a hung plug-in nothing, the others still answer", async () => {
    const plugins = [
      definePlugin({ id: "slow", menu: () => new Promise<never>(() => {}) }),
      definePlugin({ id: "ok", menu: () => [item("a")] }),
    ];
    expect((await pluginMenu(plugins, admin, 20)).map((i) => i.id)).toEqual(["ok:a"]);
    expect(await pluginMenu(plugins, { ...admin, role: "visitor" }, 20)).toEqual([]);
  });

  it("answers GET /api/activity/menu as JSON", async () => {
    const app = new Hono<any>();
    app.use("*", async (c, next) => { c.set("user", admin); await next(); });
    app.route("/api/activity", activityApp([definePlugin({ id: "tiny", menu: () => [item("a")] })]));
    const res = await app.request("/api/activity/menu");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "tiny:a", title: "Item a", href: "/tiny" }]);
  });
});

describe("appTools", () => {
  it("lists the app's tools by name in menu order, Finals and the AI Editor included", () => {
    expect(appTools(admin).map((t) => t.title)).toEqual(["Home", "Workshop", "AI Editor", "Finals", "Analyzer"]);
  });

  it("leaves out a tool whose gate the account has switched off, admins excepted", () => {
    const member: SessionUser = { ...admin, role: "user", off: ["editor", "media"] };
    expect(appTools(member).map((t) => t.id)).toEqual(["home", "workshop", "analyzer"]);
    expect(appTools({ ...member, role: "admin" })).toHaveLength(5);
  });

  it("gives visitors none", () => {
    expect(appTools({ ...admin, role: "visitor" })).toEqual([]);
  });
});
