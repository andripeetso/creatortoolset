import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, expect, it, vi } from "vitest";
import { ffmpegCommand } from "../ffmpeg-runtime";

// Blur faces, the whole road (P2.6): a clip not blurred goes through the server's own worker (card picture, strip, proxy,
// waveform, shot descriptions, description), a Mac's in-place index with its stills, a computer's job that fails its AI
// call, and a Review filing. After it, nothing on this server's disk (its data folder and the held stills' temp folder)
// is a picture or copy of that clip, its held original from before the switch excepted. The AI is stood in for.
vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(() => ({})), completeWithFallback: vi.fn(async () => { throw new Error("no AI in this test"); }) };
});
vi.mock("../ai-vision", () => ({ completeVisionWithFallback: vi.fn(async () => { throw new Error("no AI in this test"); }) }));

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "blur-walk-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_SCRATCH_DIR = path.join(dir, "scratch");
process.env.LIBRARY_DISK_RESERVE_GB = "0";
delete process.env.APP_SECRET; // the solo install: "local" is the admin
afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
});

// first: it sets library/worker.ts leaveToComputers as it loads, which an import cycle on main breaks the other way round
const { acceptLibraryFile, applyLibraryResult } = await import("../work/library-package");
const { blobs, libraryDb } = await import("./db");
const { enqueueJob } = await import("./jobs");
const { tick } = await import("./worker");
const { indexOnMac } = await import("./on-mac");
const { pairDevice } = await import("../lib/devices");
const { addVersion } = await import("../review");
const { REFUSED_BLUR } = await import("./upload-gate");
const { completeVisionWithFallback } = await import("../ai-vision");

const d = libraryDb();
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_walk', 'local', 'Library', 'local', ?, 0)").run(
  JSON.stringify({ upload: "proxies", blurFaces: true, proxy: true, describe: true, look: true, transcribe: false, embed: false }),
);

// the held original: a clip of Tiny Acrobatics the server kept from before Blur faces was on
const clip = path.join(dir, "fixture.mp4");
execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10",
  "-f", "lavfi", "-i", "sine=duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const ORIGINAL = sha(readFileSync(clip));
const held = "v_walk_held";
const heldKey = `libraries/lib_walk/v/${held}/source`;
copyFileSync(clip, path.join(dir, "fixture-copy.mp4")); // the store may move what it is given
await blobs.put(heldKey, path.join(dir, "fixture-copy.mp4"));
d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('a_walk_held', 'lib_walk', 'video', 'Cartwheel', ?, 'local', 0)").run(held);
d.prepare(
  "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at, probe) VALUES (?, 'a_walk_held', 1, ?, ?, ?, 'video/mp4', 'ready', 'local', 0, ?)",
).run(held, heldKey, statSync(clip).size, ORIGINAL, JSON.stringify({ duration: 3, width: 320, height: 240, fps: 10, rotation: 0, format: "mp4", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" }));

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9)]);
const HELD_TMP = path.join(tmpdir(), "ct-held-stills");

function walk(p: string, out: string[] = []): string[] {
  if (!existsSync(p)) return out;
  for (const n of readdirSync(p)) {
    const f = path.join(p, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else out.push(f);
  }
  return out;
}

it("leaves no picture or copy of a clip not blurred anywhere on the server, whatever ran on it", async () => {
  // the server's own worker on the held original
  for (const kind of ["thumb", "sprite", "proxy", "wave", "look", "describe"]) enqueueJob(d, "lib_walk", held, kind, "local");
  // before any computer is paired: the server's worker runs them all itself
  for (let i = 0; i < 60 && (await tick()); i++);
  const states = d.prepare("SELECT kind, state, error FROM jobs WHERE version_id = ? ORDER BY kind").all(held) as { kind: string; state: string; error: string | null }[];
  // each ran: done, or failed at the stood-in AI after reading its pictures (queued again for a retry, its error kept)
  expect(states.map((s) => s.kind)).toEqual(["describe", "look", "proxy", "sprite", "thumb", "wave"]);
  expect(states.filter((s) => s.state === "running" || (s.state === "queued" && !s.error)), JSON.stringify(states)).toEqual([]);
  // a Mac's in-place index with its card picture, strip and stills: the stills held in memory for the description
  const mac = pairDevice("local", "Tiny Mac").device;
  const onMac = (await indexOnMac("lib_walk", "local", {
    name: "Handstand.mov", path: "/Volumes/Tiny Footage/Handstand.mov", size: 2000, quick: sha("q-handstand"), device: mac.id,
    thumb: JPEG.toString("base64"), sprite: JPEG.toString("base64"), frames: [0, 1, 2, 3].map(() => JPEG.toString("base64")),
  })) as { versionId: string };
  for (let i = 0; i < 60 && (await tick()); i++);
  expect(vi.mocked(completeVisionWithFallback)).toHaveBeenCalled(); // the Mac clip's held stills went to the (stood-in) AI

  // a computer's description job: its stills arrive, its AI call fails, nothing of them stays
  d.prepare("DELETE FROM jobs WHERE version_id = ? AND kind = 'describe'").run(onMac.versionId);
  const job = Number((d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, held_by) VALUES ('lib_walk', ?, 'describe', 'running', 'local', ?) RETURNING id").get(onMac.versionId, mac.id) as { id: number }).id);
  for (const s of ["still0", "still1"]) expect(await acceptLibraryFile(job, mac.id, s, Readable.from([JPEG]))).toBe(true);
  expect(await applyLibraryResult(job, mac.id, { v: 1, outcome: { done: true }, files: ["still0", "still1"] })).toBe("failed");

  // a Review filing of a cut nobody said is blurred
  await expect(addVersion(undefined, { owner: "local", name: "Cut.mp4", mime: "video/mp4", bytes: 4 }, async () => {})).rejects.toThrow(REFUSED_BLUR);

  const unblurred = [held, onMac.versionId];
  expect(d.prepare(`SELECT version_id, kind FROM derivatives WHERE version_id IN (?, ?) AND kind <> 'wave' AND kind <> 'fingerprint'`).all(...unblurred)).toEqual([]);
  const files = [...walk(dir), ...walk(HELD_TMP)];
  for (const f of files) {
    // the held original itself (kept; deleting it is the owner's call) and its waveform are the only files of these clips
    if (f.endsWith(`${held}${path.sep}source`) || f.endsWith("wave.json")) continue;
    for (const v of unblurred) expect(f.includes(v), f).toBe(false);
    expect(/\.(jpe?g|png|mp4|mov|webp)$/i.test(f) && !f.endsWith("fixture.mp4") && !f.endsWith("fixture-copy.mp4"), f).toBe(false);
    expect(f.endsWith(".db") || sha(readFileSync(f)) !== ORIGINAL || f.endsWith("fixture.mp4") || f.endsWith("fixture-copy.mp4") || f.endsWith("source"), f).toBe(true);
  }
  expect(existsSync(path.join(dir, "library", "incoming", String(job)))).toBe(false);
});
