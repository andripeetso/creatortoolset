import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
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
  }, 30_000); // the first call loads every tool's module (appWork), slow on a busy machine
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

  it("lists each tool's running work: the thing, the tool and what it does, how far when it is not waiting", () => {
    const rows = appRows({
      libraries: [],
      edits: [],
      exports: [],
      analyzer: [
        { id: "p1", kind: "post", name: "@tinyacrobatics", waits: false },
        { id: "p2", kind: "post", name: "@tinyacrobatics", waits: true },
        { id: "a1", kind: "account", name: "@tinyacrobatics", waits: false },
        { id: "tiny:", kind: "ideas", name: "Ideas", waits: false },
      ],
      notes: [{ id: "n1", name: "Tiny walkthrough", progress: 0.4, section: false }, { id: "n2", name: "Older note", progress: undefined, section: true }],
      enhance: [{ id: "s1", name: "voice.wav", waits: false, progress: 0.3 }, { id: "s2", name: "next.wav", waits: true, progress: 0 }],
      review: [{ id: "r1/2", assetId: "r1", name: "Tiny cut", progress: 0.5 }],
      guides: [{ id: "g1", name: "Tiny walkthrough" }],
      captioning: [{ id: "c1", name: "Tiny talk" }],
      knowledge: [{ id: "k1", name: "Tiny handbook" }],
    });
    expect(rows.map((r) => [r.title, r.detail, r.href, r.progress])).toEqual([
      ["@tinyacrobatics", "Content Analyzer · reading the post", "/instagram/p1", undefined],
      ["@tinyacrobatics", "Content Analyzer · waits its turn", "/instagram/p2", undefined],
      ["@tinyacrobatics", "Content Analyzer · pulling the account", "/instagram/accounts/a1", undefined],
      ["Ideas", "Content Analyzer · finding ideas", "/instagram", undefined],
      ["Tiny walkthrough", "Video Notes · making the note", "/clips/n1", 0.4],
      ["Older note", "Video Notes · writing a section", "/clips/n2", undefined],
      ["voice.wav", "Audio Enhancer · enhancing", "/enhance/s1", 0.3],
      ["next.wav", "Audio Enhancer · waits its turn", "/enhance/s2", undefined],
      ["Tiny cut", "Review · preparing the video", "/review/r1", 0.5],
      ["Tiny walkthrough", "Guide Builder · writing", "/documents", undefined],
      ["Tiny talk", "Caption Studio · captioning", "/captions?view=projects", undefined],
      ["Tiny handbook", "Content Workshop · reading the source", "/workshop", undefined],
    ]);
    expect(rows.every((r) => r.state === "working")).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
});

describe("GET /api/activity", () => {
  const rowsFor = async (off: string[]) => {
    const tiny: SessionUser = { ...admin, username: "tiny-activity", role: "user", off };
    const app = new Hono<any>();
    app.use("*", async (c, next) => { c.set("user", tiny); await next(); });
    app.route("/api/activity", activityApp([]));
    const res = await app.request("/api/activity");
    expect(res.status).toBe(200);
    return (await res.json()) as ActivityRow[];
  };

  it("reads a tool's rows while its gate is on, none when it is off, and a tool that fails to read hides nobody else's", async () => {
    vi.doMock("./clips", () => ({ notesWork: async () => [{ id: "n1", name: "Tiny walkthrough", progress: 0.5, section: false }] }));
    vi.doMock("./review", () => ({ reviewWork: async () => { throw new Error("tiny read failed"); } }));
    const others = ["instagram", "enhance", "guides", "captions", "workshop", "media", "editor"];
    try {
      expect((await rowsFor(others)).map((r) => [r.id, r.detail])).toEqual([["notes:n1", "Video Notes · making the note"]]);
      expect(await rowsFor([...others, "notes"])).toEqual([]);
    } finally {
      vi.doUnmock("./clips");
      vi.doUnmock("./review");
    }
  });

  it("counts an Audio Enhancer pass on a plug-in engine's own worker until it is back", async () => {
    const { enhanceHost, enhancing } = await import("./enhance");
    const meta = { id: "tiny-away-1", name: "voice.wav", owner: "tiny", hasVideo: false, duration: 1, bytes: 1, status: "queued" as const, remote: { state: "waiting" as const, at: 1 }, progress: 0.05, createdAt: 1, updatedAt: 1 };
    await enhanceHost.persist(meta);
    expect(enhancing("tiny")).toEqual([{ id: "tiny-away-1", name: "voice.wav", waits: true, progress: 0.05 }]);
    expect(enhancing("someone-else")).toEqual([]);
    await enhanceHost.persist({ ...meta, status: "running", remote: { state: "claimed", at: 2 } });
    expect(enhancing("tiny")[0]?.waits).toBe(false);
    await enhanceHost.persist({ ...meta, status: "done", remote: undefined });
    expect(enhancing("tiny")).toEqual([]);
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
