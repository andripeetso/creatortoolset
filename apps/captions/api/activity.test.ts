import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { ActivityRow, ActivityState } from "./activity";
import type { SessionUser } from "./users";

// GET /api/activity reads the app's own tools: an empty data folder of its own
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "activity-"));
process.env.DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const { definePlugin } = await import("./lib/plugin");
const { activityApp, appRows, appTools, pluginActivity, pluginMenu } = await import("./activity");

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

  it("passes a row's progress and reason only when well-formed, and no other field", async () => {
    const plugins = [definePlugin({ id: "tiny", activity: () => [
      { ...row("a"), progress: 0.5, reason: "Waits for Tiny" },
      { ...row("b"), progress: 2, reason: "  " },
      { ...row("c"), extra: "x" } as ActivityRow,
    ] })];
    const rows = await pluginActivity(plugins, admin);
    expect(rows[0]).toMatchObject({ progress: 0.5, reason: "Waits for Tiny" });
    expect(rows[1]).toEqual({ id: "tiny:b", title: "Row b", detail: "Tiny", state: "working", href: "/editor" });
    expect(rows[2]).not.toHaveProperty("extra");
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

describe("appRows", () => {
  const progress = { done: 0, left: 0, clips: 0, share: 0, seconds: 0, waiting: [] };
  it("says the clips being prepared with how far, then in a few words what waits for the person, opening where they add it", () => {
    const rows = appRows({
      libraries: [{
        id: "l",
        uploading: null,
        progress: {
          done: 9, left: 27, clips: 17, share: 0.25, seconds: 60,
          waiting: [
            { step: "transcript", count: 2, missing: "Add a Tiny key" },
            { step: "describe", count: 5, missing: "No AI for your account: add one in Settings → Providers, or your Anthropic key in Settings → API keys" },
          ],
        },
      }],
      edits: [],
      exports: [],
    });
    expect(rows.map((r) => [r.detail, r.state, r.href])).toEqual([
      ["Preparing 17 clips · 25%", "working", "/library"],
      ["2 transcripts need a transcription key", "ready", "/settings/keys"],
      ["5 AI descriptions need an AI", "ready", "/settings/providers"],
    ]);
    expect(rows[0].progress).toBe(0.25);
  });

  it("lists running edits and renders, each opening its own page", () => {
    const rows = appRows({
      libraries: [{ id: "l", uploading: null, progress }],
      edits: [{ id: "e1", name: "Tiny vlog" }],
      exports: [
        { id: "x1", filename: "tiny.mp4", status: "running", progress: 0.4, projectId: "p 1" },
        { id: "x2", filename: "next.mp4", status: "queued", progress: 0, projectId: undefined },
      ],
    });
    expect(rows.map((r) => [r.title, r.detail, r.href])).toEqual([
      ["Tiny vlog", "AI Editor", "/editor/e1"],
      ["tiny.mp4", "Exporting · 40%", "/captions?project=p%201"],
      ["next.mp4", "Export · waits its turn", "/captions"],
    ]);
    expect(rows[2]).not.toHaveProperty("progress");
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
