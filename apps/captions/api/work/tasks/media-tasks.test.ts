import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WORK_V, type TaskPackage } from "../../../contracts/work";
import type { AuthVars } from "../../auth";
import { ffmpegCommand } from "../../ffmpeg-runtime";

/**
 * The P3e tasks on their two roads: with the server's video work off each one waits with its line and the server makes
 * nothing; a computer of the asker claims it and the server files what it made, the same as when the server made it.
 */

const root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "media-tasks-"));
process.env.DATA_DIR = path.join(root, "data");
mkdirSync(process.env.DATA_DIR, { recursive: true });
process.env.APP_SECRET = "media-tasks-test-secret";
vi.mock("../../plugins.gen", () => ({ serverPlugins: [] }));

const boot = (await import("../../boot")).default;
const { pairDevice, setDeviceWork } = await import("../../lib/devices");
const { CLAIM_POLL } = await import("../routes");
const { client } = await import("../computer");
const { writeServerWork } = await import("../server-work");
const { runTaskJob, taskFor } = await import("../tasks");
const { blobs, libraryDb } = await import("../../library/db");
const { collectionApp } = await import("../../library/collections");
const { backfillFingerprints } = await import("../../instagram");
const { printPosts } = await import("../../lib/connectors/prints");
const { findAccount, saveAccounts } = await import("../../lib/connectors/store");
const { phashPerSecond } = await import("../../library/fingerprint");
const { createUser } = await import("../../users");
CLAIM_POLL.holdMs = 0;
afterAll(() => rmSync(root, { recursive: true, force: true }));

createUser("tiny", "password1", { role: "user" });
const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "tiny", role: "user" } as never);
  return next();
});
app.route("/api/library", collectionApp);
const call = async (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

const pc = pairDevice("tiny", "Tiny Mac");
const o = { server: "http://server.test", token: pc.token, beatMs: 20, fetch: (u: string, i?: RequestInit) => Promise.resolve(boot.request(u, i)) };
const c = client(o);
const claim = async (tasks: string[]) => (await c.post<{ task?: TaskPackage }>("work/claim", { v: WORK_V, steps: [], tasks })).task;
/** The computer no longer takes tasks: the server's own road. */
const computerOff = () => setDeviceWork(pc.device.id, { v: WORK_V, steps: [] });

const ff = (args: string[]) => execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe" });
const clip = path.join(root, "tiny-acrobatics.mp4");
const WAITS = /^Waits for one of your computers/;

beforeAll(async () => {
  // two seconds of picture and sound, made here
  ff(["-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=25", "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
  const d = libraryDb();
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_t', 'tiny', 'Tiny', 'local', 0)").run();
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('a1', 'lib_t', 'video', 'Floor roll', 'a1-v1', 'tiny', 1)").run();
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('a1-v1', 'a1', 1, 'libraries/lib_t/v/a1-v1/source', 1, 'h1', 'ready', 'tiny', 1)").run();
  // the store takes the file it is given: a copy
  copyFileSync(clip, `${clip}.put`);
  await blobs.put("libraries/lib_t/v/a1-v1/source", `${clip}.put`);
});

async function piece(label: string): Promise<string> {
  const p = (await (await call("POST", "/api/library/lib_t/pieces", { label })).json()) as { id: string };
  await call("POST", `/api/library/lib_t/pieces/${p.id}/items`, { versionId: "a1-v1" });
  return p.id;
}
const coverBytes = async (id: string) => {
  const p = (await (await call("GET", `/api/library/lib_t/pieces/${id}`)).json()) as { coverUrl: string | null };
  return p.coverUrl ? Buffer.from(await (await call("GET", p.coverUrl)).arrayBuffer()) : null;
};

/** A saved Analyzer post of the person's with one downloaded video slide and no fingerprint yet. */
function post(id: string): string {
  const dir = path.join(process.env.DATA_DIR!, "instagram", id);
  mkdirSync(path.join(dir, "media"), { recursive: true });
  writeFileSync(path.join(dir, "media", "00.mp4"), readFileSync(clip));
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
    id, owner: "tiny", status: "ready", progress: 1, input: "https://www.instagram.com/p/TINY/", url: "https://www.instagram.com/p/TINY/", shortcode: id,
    kind: "reel", creator: { id: "1", username: "tinyacrobatics" }, takenAt: 1, caption: "Floor roll", counts: { likes: 1, comments: 0, fetchedAt: 1 },
    comments: { status: "skipped", count: 0, replies: 0 }, bytes: 1, createdAt: 1, updatedAt: 1, jobs: [], tags: [],
    slides: [{ index: 0, kind: "video", file: "media/00.mp4", mime: "video/mp4", bytes: 1, durationS: 2, transcript: { status: "skipped" }, vision: { status: "skipped" } }],
  }));
  return path.join(dir, "meta.json");
}
const printOf = (meta: string) => (JSON.parse(readFileSync(meta, "utf8")) as { slides: Array<{ fingerprint?: { h: string[] } }> }).slides[0]!.fingerprint;

describe("with the server's video work off and no computer online", () => {
  it("a Finals cover waits with the line, and the server makes no frame", async () => {
    writeServerWork({ on: false });
    const id = await piece("Waiting");
    const res = await call("POST", `/api/library/lib_t/pieces/${id}/cover`, { versionId: "a1-v1", t: 1 });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { coverWaits: string }).coverWaits).toMatch(WAITS);
    expect(taskFor("frame", `cover:${id}`)?.state).toBe("queued");
    expect(await coverBytes(id)).toBeNull();
    // the page reads the same line back
    expect(((await (await call("GET", `/api/library/lib_t/pieces/${id}`)).json()) as { coverWaits?: string }).coverWaits).toMatch(WAITS);
  });

  it("the Analyzer's start-up fingerprint pass queues the post and hashes nothing here", async () => {
    const meta = post("tiny-post-1");
    await backfillFingerprints();
    expect(taskFor("post-media", "tiny-post-1")?.state).toBe("queued");
    expect(printOf(meta)).toBeUndefined();
  });

  it("a connector's posted reels are handed over, not read here", async () => {
    saveAccounts("tiny", [{ platform: "instagram", platformId: "17009", handle: "tinyacrobatics", via: "login", token: "t", posts: [{ id: "reel-1", at: 1, text: "Roll", mediaUrl: clip }] }]);
    expect(await printPosts("tiny", "instagram:17009")).toBe(1);
    expect(taskFor("posted-prints", "tiny/instagram:17009")?.state).toBe("queued");
    expect(findAccount("tiny", "instagram:17009")?.prints).toBeUndefined();
  });
});

describe("a computer of the person's takes them", () => {
  it("makes the cover, the post's fingerprint and the reel's prints, and the server files them", async () => {
    for (let t = await claim(["frame", "post-media", "posted-prints"]); t; t = await claim(["frame", "post-media", "posted-prints"])) expect(await runTaskJob(t, c, o)).toBe("done");
    expect(printOf(path.join(process.env.DATA_DIR!, "instagram", "tiny-post-1", "meta.json"))?.h.length).toBeGreaterThan(0);
    expect(findAccount("tiny", "instagram:17009")?.prints?.["reel-1"]).toEqual(await phashPerSecond(clip));
  });

  it("gives what the server gives when its video work is on", async () => {
    const [byComputer] = (libraryDb().prepare("SELECT id FROM pieces WHERE label = 'Waiting'").all() as { id: string }[]).map((r) => r.id);
    const fromComputer = await coverBytes(byComputer!);
    expect(fromComputer?.length).toBeGreaterThan(0);
    computerOff();
    writeServerWork({ on: true });
    try {
      const id = await piece("Here");
      const res = await call("POST", `/api/library/lib_t/pieces/${id}/cover`, { versionId: "a1-v1", t: 1 });
      expect(res.status).toBe(200);
      expect((await coverBytes(id))?.equals(fromComputer!)).toBe(true);
      const meta = post("tiny-post-2");
      await backfillFingerprints();
      expect(printOf(meta)).toEqual(printOf(path.join(process.env.DATA_DIR!, "instagram", "tiny-post-1", "meta.json")));
    } finally {
      writeServerWork({ on: false });
    }
  });
});
