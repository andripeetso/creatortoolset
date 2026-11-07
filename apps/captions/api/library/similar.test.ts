import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";
import { ffmpegCommand } from "../ffmpeg-runtime";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-similar-"));
process.env.DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { libraryDb } = await import("./db");
const { phashPerSecond } = await import("./fingerprint");
const { similar, similarTo } = await import("./similar");
const { cleanApp } = await import("../clean");
const { libraryApp } = await import("./routes");

const ff = (args: string[]) => execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe" });
const clip = path.join(dir, "clip.mp4");
const copy = path.join(dir, "copy.mp4");
const other = path.join(dir, "other.mp4");

/** A ready video in lib_a with its fingerprint (or none yet). */
function add(id: string, title: string, phash?: string[]) {
  const d = libraryDb();
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, ?, 'owner-a', 0)").run(id, title, `v-${id}`);
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES (?, ?, 1, 'k', 1, ?, 'ready', 'owner-a', 0)").run(`v-${id}`, id, id);
  if (phash) d.prepare("INSERT INTO derivatives (version_id, kind, inline) VALUES (?, 'fingerprint', ?)").run(`v-${id}`, JSON.stringify({ phash }));
}

beforeAll(async () => {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'owner-a', 'A', 'local', 0)").run();
  // three seconds each, made here: nothing large is committed
  ff(["-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
  ff(["-i", clip, "-vf", "scale=160:120", "-c:v", "libx264", "-crf", "38", "-pix_fmt", "yuv420p", copy]); // re-encoded, smaller
  ff(["-f", "lavfi", "-i", "mandelbrot=size=320x240:rate=10", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", other]);
  add("clip", "Tiny Acrobatics roll", await phashPerSecond(clip));
  add("copy", "Roll, re-exported", await phashPerSecond(copy));
  add("other", "Something else", await phashPerSecond(other));
  add("fresh", "Not fingerprinted yet");
});

describe("similar", () => {
  it("finds a re-encoded copy and not another video", () => {
    const r = similar("owner-a", "v-clip")!;
    expect(r.matches.map((m) => m.assetId)).toEqual(["copy"]);
    expect(r.matches[0]!.overlap).toBe(1);
    expect(r.checked).toBe(2); // copy and other; not the clip itself
    // one without a fingerprint is queued for one, once
    expect(r.pending).toBe(1);
    expect(libraryDb().prepare("SELECT state FROM jobs WHERE version_id = 'v-fresh' AND kind = 'fingerprint'").get()).toEqual({ state: "queued" });
  });

  it("answers nothing outside the caller's workspace", async () => {
    expect(similar("owner-b", "v-clip")).toBeNull();
    const app = new Hono<{ Variables: AuthVars }>();
    app.use("*", async (c, next) => {
      c.set("user", { username: c.req.header("x-user")!, role: "user", cloud: false, off: [] });
      await next();
    });
    app.route("/", libraryApp);
    expect((await app.request("/versions/v-clip/similar", { headers: { "x-user": "owner-b" } })).status).toBe(404);
    expect(((await (await app.request("/versions/v-clip/similar", { headers: { "x-user": "owner-a" } })).json()) as { matches: unknown[] }).matches).toHaveLength(1);
    expect(similarTo("owner-b", ["0000000000000000"]).matches).toEqual([]);
  });

  it("the Video Cleaner checks an upload against the library", async () => {
    const app = new Hono<{ Variables: AuthVars }>();
    app.use("*", async (c, next) => {
      c.set("user", { username: "owner-a", role: "user", cloud: false, off: [] });
      await next();
    });
    app.route("/", cleanApp);
    const up = await app.request("/sources?name=copy.mp4", { method: "POST", body: readFileSync(copy) });
    expect(up.status).toBe(201);
    const { id } = (await up.json()) as { id: string };
    const res = (await (await app.request(`/sources/${id}/duplicates`, { method: "POST" })).json()) as { matches: { assetId: string }[] };
    expect(res.matches.map((m) => m.assetId).sort()).toEqual(["clip", "copy"]);
  });
});
