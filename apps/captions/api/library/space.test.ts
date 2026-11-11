import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-space-"));
process.env.DATA_DIR = dir;
const { blobs, libraryDb } = await import("./db");
const { enqueueJob } = await import("./jobs");
const { libraryApp } = await import("./routes");

afterAll(() => {
  delete process.env.CT_LOCAL;
  rmSync(dir, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);

const d = libraryDb();
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_s', 'owner-s', 'S', 'local', 0)").run();
// a 4K clip: its proxy and picture are made files; its original is the person's own
const PROBE = JSON.stringify({ duration: 8, vcodec: "h264", acodec: "", width: 3840, height: 2160, pixFmt: "yuv420p10le", format: "mov,mp4" });
const put = async (key: string, text: string) => {
  const f = path.join(dir, `in-${Math.random()}`);
  writeFileSync(f, text);
  await blobs.put(key, f);
};
const clip = async (v: string) => {
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_s', 'video', ?, ?, 'owner-s', 1)").run(`a_${v}`, v, v);
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, probe, state, created_by, created_at)
     VALUES (?, ?, 1, ?, 9, ?, 'video/quicktime', ?, 'ready', 'owner-s', 1)`,
  ).run(v, `a_${v}`, `libraries/lib_s/v/${v}/source`, v, PROBE);
  await put(`libraries/lib_s/v/${v}/source`, "the original");
  await put(`libraries/lib_s/v/${v}/proxy.mp4`, "a proxy of ten");
  await put(`libraries/lib_s/v/${v}/thumb.jpg`, "pic");
  d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'proxy', ?, 14), (?, 'thumb', ?, 3)").run(
    v,
    `libraries/lib_s/v/${v}/proxy.mp4`,
    v,
    `libraries/lib_s/v/${v}/thumb.jpg`,
  );
  d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor) VALUES ('lib_s', ?, 'proxy', 'done', 'owner-s')").run(v);
};
const blob = (key: string) => path.join(dir, "library", "blobs", key);
const space = async (user = "owner-s") => (await app.request("/api/library/lib_s/space", { headers: { "x-user": user } })).json() as Promise<any>;
const clear = (what: string, user = "owner-s") =>
  app.request("/api/library/lib_s/space/clear", { method: "POST", headers: { "x-user": user, "content-type": "application/json" }, body: JSON.stringify({ what }) });

describe("the library's space", () => {
  it("says what its made files take, to its owner only", async () => {
    await clip("v1");
    await clip("v2");
    expect(await space()).toEqual({ proxies: { bytes: 28, files: 2 }, pictures: { bytes: 6, files: 2 }, models: null });
    expect((await app.request("/api/library/lib_s/space", { headers: { "x-user": "stranger" } })).status).toBe(404);
    expect((await clear("proxies", "stranger")).status).toBe(404);
  });

  it("clears the proxies but never an original, a picture, or the proxy of a clip being prepared", async () => {
    enqueueJob(d, "lib_s", "v2", "transcribe", "owner-s"); // v2 is being prepared: a step may be reading its proxy
    const r = await clear("proxies");
    expect(await r.json()).toEqual({ cleared: 14, kept: 1 });
    expect(existsSync(blob("libraries/lib_s/v/v1/proxy.mp4"))).toBe(false);
    expect(existsSync(blob("libraries/lib_s/v/v1/source"))).toBe(true);
    expect(existsSync(blob("libraries/lib_s/v/v1/thumb.jpg"))).toBe(true);
    expect(existsSync(blob("libraries/lib_s/v/v2/proxy.mp4"))).toBe(true);
    expect(d.prepare("SELECT kind FROM jobs WHERE version_id = 'v1'").all()).toEqual([]);
    expect((await space()).proxies).toEqual({ bytes: 14, files: 1 });
  });

  it("makes a cleared proxy again when the clip is opened", async () => {
    const play = await app.request("/api/library/media/v1/play", { headers: { "x-user": "owner-s" } });
    expect(play.status).toBe(200); // the original answers meanwhile
    expect(d.prepare("SELECT state FROM jobs WHERE version_id = 'v1' AND kind = 'proxy'").get()).toEqual({ state: "queued" });
    await app.request("/api/library/media/v1/play", { headers: { "x-user": "owner-s" } });
    expect((d.prepare("SELECT COUNT(*) AS n FROM jobs WHERE version_id = 'v1' AND kind = 'proxy'").get() as { n: number }).n).toBe(1);
  });

  it("proxies off: none is queued, nor made again on opening; on again: the clips without one get one", async () => {
    d.prepare("DELETE FROM jobs").run();
    const set = (proxy: boolean) =>
      app.request("/api/library/lib_s", { method: "PATCH", headers: { "x-user": "owner-s", "content-type": "application/json" }, body: JSON.stringify({ settings: { proxy } }) });
    enqueueJob(d, "lib_s", "v1", "proxy", "owner-s");
    expect(((await (await set(false)).json()) as { settings: { proxy: boolean } }).settings.proxy).toBe(false);
    expect(d.prepare("SELECT 1 FROM jobs WHERE kind = 'proxy'").get()).toBeUndefined();
    await app.request("/api/library/media/v1/play", { headers: { "x-user": "owner-s" } });
    expect(d.prepare("SELECT 1 FROM jobs WHERE kind = 'proxy'").get()).toBeUndefined();
    await set(true);
    expect(d.prepare("SELECT version_id, state FROM jobs WHERE kind = 'proxy'").all()).toEqual([{ version_id: "v1", state: "queued" }]); // v2 has its proxy
  });

  it("clears the downloaded models on the person's own computer, not while a transcript is made, and nowhere else", async () => {
    expect((await clear("models")).status).toBe(403);
    process.env.CT_LOCAL = "1";
    mkdirSync(path.join(dir, "models", "Xenova", "whisper-base"), { recursive: true });
    writeFileSync(path.join(dir, "models", "Xenova", "whisper-base", "model.onnx"), "weights");
    expect((await space()).models).toEqual({ bytes: 7 });
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor) VALUES ('lib_s', 'v2', 'transcribe', 'running', 'owner-s')").run();
    expect((await clear("models")).status).toBe(409);
    d.prepare("DELETE FROM jobs WHERE kind = 'transcribe'").run();
    expect(await (await clear("models")).json()).toEqual({ cleared: 7, kept: 0 });
    expect(existsSync(path.join(dir, "models"))).toBe(false);
    expect(existsSync(blob("libraries/lib_s/v/v2/source"))).toBe(true);
    expect((await clear("originals")).status).toBe(400);
  });
});
