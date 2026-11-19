import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "./auth";
import type { KeptView } from "../contracts/storage";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "kept-"));
process.env.DATA_DIR = dataDir;
// the studio suite runs hosted (CT_MODE=hosted), where the admin's workspace storage is off (kept.ts workspaceStorageAllowed);
// this file tests a server that is not Cloud, so the mode is cleared here and put back after
const hostedWas = process.env.CT_MODE;
delete process.env.CT_MODE;
afterAll(() => {
  if (hostedWas !== undefined) process.env.CT_MODE = hostedWas;
  rmSync(dataDir, { recursive: true, force: true });
});

const at = (rel: string) => path.join(dataDir, rel);
const put = (rel: string, data: string | number) => {
  mkdirSync(path.dirname(at(rel)), { recursive: true });
  writeFileSync(at(rel), typeof data === "number" ? Buffer.alloc(data, 1) : data);
};
const has = (rel: string) => existsSync(at(rel));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// chat pictures: one each for two accounts
put("assistant/images/tiny/a.png", 5);
put("assistant/images/other/b.png", 3);
// chat videos: one of its own, one still uploading, one that Review also has (the same file under a second name)
put(`assistant/files/tiny/${id(1)}/file`, 1000);
put(`assistant/files/tiny/${id(2)}/parts/1`, 400);
put(`review/${id(10)}/meta.json`, JSON.stringify({ id: id(10), owner: "tiny", versions: [] }));
put(`review/${id(10)}/v1/source`, 2000);
mkdirSync(at(`assistant/files/tiny/${id(3)}`), { recursive: true });
linkSync(at(`review/${id(10)}/v1/source`), at(`assistant/files/tiny/${id(3)}/file`));
put(`review/${id(11)}/meta.json`, JSON.stringify({ id: id(11), owner: "other", versions: [] }));
// the trash of both tools
put(`review/trash/${id(12)}/meta.json`, JSON.stringify({ id: id(12), name: "old", owner: "tiny", versions: [], approval: { status: "none" }, createdAt: 0, deletedAt: Date.now() }));
put(`review/trash/${id(12)}/v1/source`, 3000);
put(`review/trash/${id(13)}/meta.json`, JSON.stringify({ id: id(13), name: "theirs", owner: "other", versions: [], approval: { status: "none" }, deletedAt: Date.now() }));
const project = (pid: string, deletedAt?: number) => {
  put(`projects/${pid}/meta.json`, JSON.stringify({ id: pid, name: pid, owner: "tiny", createdAt: 0, updatedAt: 0, duration: 0, deletedAt, clips: [{ id: "clip-01", name: "a", duration: 0, createdAt: 0 }] }));
  put(`projects/${pid}/clips/clip-01/original`, 700);
  put(`projects/${pid}/clips/clip-01/proxy.mp4`, 70); // a proxy is there, so the app doesn't try to make one from the sample file
};
project("live-one");
project("binned", Date.now());
// a finished render, and one on its way to Finals
const render = (n: number, finals?: { status: string }) => {
  put(`exports/${id(n)}/job.json`, JSON.stringify({ id: id(n), owner: "tiny", status: "done", kind: "burn", format: "mp4", filename: "out.mp4", params: {}, createdAt: Date.now(), finishedAt: Date.now(), engine: "wysiwyg", finals }));
  put(`exports/${id(n)}/out.mp4`, 900);
};
render(20);
render(21, { status: "sending" });
// posts made before accounts have no owner; a Workshop source with its text
put("instagram/p1/meta.json", JSON.stringify({}));
put("workshop/sources/s1.json", JSON.stringify({ owner: "tiny" }));
put("workshop/sources/s1.txt", 50);

// a trashed Review video as a real one is: the Media Library holds the same file under a second name
const { libraryDb } = await import("./library/db");
const blob = `library/blobs/libraries/lib_t/v/${id(30)}/source`;
libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_t', 'tiny', 'Library', 'local', 0)").run();
libraryDb().prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, trashed_at) VALUES (?, 'lib_t', 'video', 'old', NULL, 'tiny', 0, 1)").run(id(12));
libraryDb()
  .prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 3000, '', 'video/mp4', NULL, 'ready', 'tiny', 0)")
  .run(id(30), id(12), `libraries/lib_t/v/${id(30)}/source`);
mkdirSync(path.dirname(at(blob)), { recursive: true });
linkSync(at(`review/trash/${id(12)}/v1/source`), at(blob));

const { keptView, emptyKept } = await import("./kept");
const { storageApp } = await import("./devices-storage");
const tiny = { username: "tiny", role: "user" } as Parameters<typeof keptView>[0];
const admin = { username: "local", role: "admin" } as Parameters<typeof keptView>[0]; // with no APP_SECRET the first admin is "local"
const second = { username: "boss", role: "admin" } as Parameters<typeof keptView>[0];
const row = async (u: typeof tiny, kind: string) => (await keptView(u)).rows.find((r) => r.kind === kind)!;

it("counts only the account's own files, and owner-less ones for the first admin", async () => {
  expect(await row(tiny, "chat-pictures")).toMatchObject({ items: 1, bytes: 5 });
  expect(await row(tiny, "analyzer")).toMatchObject({ items: 0 });
  expect(await row(admin, "analyzer")).toMatchObject({ items: 1 });
  expect(await row(second, "analyzer")).toMatchObject({ items: 0 }); // one account has them, so admins never both count them
  expect((await row(tiny, "workshop")).bytes).toBeGreaterThanOrEqual(50);
  expect(await row(tiny, "captions")).toMatchObject({ items: 1 });
});

it("a chat video Review also has counts once, as Review's; one still uploading is not counted", async () => {
  expect((await row(tiny, "review")).bytes).toBeGreaterThanOrEqual(2000);
  const chat = await row(tiny, "chat-videos");
  expect(chat).toMatchObject({ items: 1, keepDays: 7 });
  expect(chat.bytes).toBe(1000);
});

it("the trash has its own rows, and a render going to Finals is not counted", async () => {
  expect(await row(tiny, "review-trash")).toMatchObject({ items: 1, keepDays: 30 });
  expect((await row(tiny, "review-trash")).bytes).toBeGreaterThanOrEqual(3000);
  expect((await row(tiny, "library")).bytes).toBe(0); // the trashed video's file is the trash's, counted once
  expect(await row(tiny, "captions-trash")).toMatchObject({ items: 1, keepDays: 5 });
  expect(await row(tiny, "exports")).toMatchObject({ items: 1 });
});

it("the Media Library row counts the account's libraries in every workspace, like the other rows", async () => {
  const before = (await row(tiny, "library")).bytes;
  // a second library of the same account, in another workspace (its settings.projectId), and another account's
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_t2', 'tiny', 'Library', 'local', ?, 1)").run(JSON.stringify({ projectId: "ws-other" }));
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_o', 'other', 'Library', 'local', 2)").run();
  put("library/blobs/libraries/lib_t2/v/x/source", 4000);
  put("library/blobs/libraries/lib_o/v/y/source", 9000);
  expect((await row(tiny, "library")).bytes).toBe(before + 4000);
});

it("Empty deletes what the row counts and nothing else", async () => {
  for (const kind of ["chat-pictures", "chat-videos", "review-trash", "captions-trash", "exports"] as const) await emptyKept(kind, tiny);
  expect(has("assistant/images/tiny/a.png")).toBe(false);
  expect(has("assistant/images/other/b.png")).toBe(true);
  expect(has(`assistant/files/tiny/${id(1)}`)).toBe(false);
  expect(has(`assistant/files/tiny/${id(2)}/parts/1`)).toBe(true); // still uploading
  expect(has(`assistant/files/tiny/${id(3)}/file`)).toBe(true); // Review's file: deleting it would free nothing
  expect(has(`review/${id(10)}/v1/source`)).toBe(true);
  expect(has(`review/trash/${id(12)}`)).toBe(false);
  expect(has(blob)).toBe(false); // the Media Library's name for it goes too, so the space is really freed
  expect(has(`review/trash/${id(13)}`)).toBe(true); // another account's
  expect(has("projects/binned")).toBe(false);
  expect(has("projects/live-one")).toBe(true);
  expect(has(`exports/${id(20)}`)).toBe(false);
  expect(has(`exports/${id(21)}`)).toBe(true); // on its way to Finals
});

it("through the route: a member reads their own, only the short-lived kinds can be emptied, a guest gets nothing", async () => {
  const as = (user: object) => {
    const app = new Hono<{ Variables: AuthVars }>();
    app.use(async (c, next) => {
      c.set("user", user as never);
      return next();
    });
    app.route("/api/devices/storage", storageApp);
    return app;
  };
  const member = as(tiny);
  const got = await member.request("/api/devices/storage/kept");
  expect(got.status).toBe(200);
  expect(((await got.json()) as KeptView).rows.find((r) => r.kind === "review")).toMatchObject({ items: 1 });
  expect((await member.request("/api/devices/storage/kept/review/empty", { method: "POST" })).status).toBe(400);
  expect(has(`review/${id(10)}/v1/source`)).toBe(true);
  expect((await member.request("/api/devices/storage/kept/chat-pictures/empty", { method: "POST" })).status).toBe(200);
  expect((await as({ username: "guest", role: "visitor" }).request("/api/devices/storage/kept")).status).toBe(403);
});

it("each computer's proxies are a row of their own, counted from its last claim; Empty tells only that computer", async () => {
  const { pairDevice, setDeviceWork, deviceOf } = await import("./lib/devices");
  const mac = pairDevice("tiny", "Studio Mac").device;
  const pc = pairDevice("tiny", "Edit PC").device;
  pairDevice("other", "Their Mac");
  setDeviceWork(mac.id, { v: 1, steps: [], cache: { bytes: 900, versions: ["va", "vb"] } });
  setDeviceWork(pc.id, { v: 1, steps: [], cache: { bytes: 50, versions: ["va"] } });
  const proxies = async () => (await keptView(tiny)).rows.filter((r) => r.kind === "proxies");
  expect(await proxies()).toEqual([
    { kind: "proxies", bytes: 900, items: 2, device: { id: mac.id, name: "Studio Mac" }, limit: 25e9 },
    { kind: "proxies", bytes: 50, items: 1, device: { id: pc.id, name: "Edit PC" }, limit: 25e9 },
  ]);
  await emptyKept("proxies", tiny, mac.id);
  expect(deviceOf(mac.id)!.work).toMatchObject({ empty: true, cache: { bytes: 0, versions: [] } });
  expect(deviceOf(pc.id)!.work!.empty).toBeUndefined();
});

it("Storage › Workspaces (admin): a library's bytes under its workspace, one with none under the first workspace", async () => {
  put("workshop/projects/ws-first.json", JSON.stringify({ id: "ws-first", name: "First", createdAt: 1 }));
  put("workshop/projects/ws-other.json", JSON.stringify({ id: "ws-other", name: "Other", createdAt: 2 }));
  const { workspaceStorage } = await import("./kept");
  // lib_o has no projectId (9000 bytes, first); lib_t2 is in ws-other (4000); lib_t's blob was emptied above
  expect(await workspaceStorage()).toEqual([
    { id: "ws-first", name: "First", bytes: 9000 },
    { id: "ws-other", name: "Other", bytes: 4000 },
  ]);
  const { storageApp } = await import("./devices-storage");
  const app = new Hono<{ Variables: AuthVars }>();
  app.use(async (c, next) => {
    c.set("user", (c.req.header("x-who") === "admin" ? admin : tiny) as never);
    return next();
  });
  app.route("/api/devices/storage", storageApp);
  expect((await app.request("/api/devices/storage/kept/workspaces", { headers: { "x-who": "admin" } })).status).toBe(200);
  expect((await app.request("/api/devices/storage/kept/workspaces")).status).toBe(403);
});

it("Storage › Workspaces: an owner's library counts under the owner's first workspace, a gone one too; none on Cloud", async () => {
  const { createUser } = await import("./users");
  createUser("boss", "password1", { role: "admin" });
  put("workshop/projects/ws-boss.json", JSON.stringify({ id: "ws-boss", name: "Boss brand", owner: "boss", createdAt: 3 }));
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_boss', 'boss', 'B', 'local', '{}', 0);
    INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_gone', 'boss', 'G', 'local', '{"projectId":"ws-deleted"}', 0);
  `);
  put("library/blobs/libraries/lib_boss/source", 500);
  put("library/blobs/libraries/lib_gone/source", 300);
  const { workspaceStorage } = await import("./kept");
  expect((await workspaceStorage()).find((w) => w.id === "ws-boss")).toEqual({ id: "ws-boss", name: "Boss brand", bytes: 800 });
  expect((await workspaceStorage()).find((w) => w.id === "ws-other")?.bytes).toBe(4000);
  const { storageApp } = await import("./devices-storage");
  const app = new Hono<{ Variables: AuthVars }>();
  app.use(async (c, next) => {
    c.set("user", admin as never);
    return next();
  });
  app.route("/api/devices/storage", storageApp);
  process.env.CT_MODE = "hosted";
  try {
    expect((await app.request("/api/devices/storage/kept/workspaces")).status).toBe(403);
  } finally {
    delete process.env.CT_MODE;
  }
});
