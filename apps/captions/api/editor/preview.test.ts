import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import { ffmpegCommand } from "../ffmpeg-runtime";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-preview-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-preview-test-secret";
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({
    workspaces: [{ id: "ws_a", name: "Tiny Acrobatics", plan: "team", comped: false, createdAt: 0, members: [{ username: "mem-a", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 }] }],
    invites: [],
    spend: {},
  }),
);

const { blobs, libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { readMeta } = await import("../review");
const { emptyTracks } = await import("./timeline");
const { createEdit, readStep, saveDraft } = await import("./store");
const { previewSize, renderPreview, shotFilter } = await import("./preview");
const { tick } = await import("./worker");

const fixture = path.join(dir, "Tiny Acrobatics take.mp4");
const ffprobe = (file: string, ...args: string[]) =>
  execFileSync(ffmpegCommand().replace(/ffmpeg$/, "ffprobe"), ["-v", "error", ...args, file], { encoding: "utf8" }).trim();
/** One grey frame of `file` as raw bytes. */
const frame = (file: string, n: number) =>
  execFileSync(ffmpegCommand(), ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);

/** Two shots of the same source frames, 15 frames each: the second punched in and tilted. */
const timeline = (): Timeline => {
  const t: Timeline = {
    name: "Hook v1",
    fps: 30,
    width: 360,
    height: 640,
    sources: { ver_a: { versionId: "ver_a", name: "Take", fps: 30, tc: 0, dur: 90, w: 360, h: 640 } },
    tracks: emptyTracks(),
    markers: [],
  };
  t.tracks.V1.items = [
    { src: "ver_a", in: 10, len: 15, rec: 0, link: "c1" },
    { src: "ver_a", in: 10, len: 15, rec: 15, link: "c2", zoom: 1.5, tilt: 40 },
  ];
  t.tracks.A1.items = t.tracks.V1.items.map(({ src, in: i, len, rec, link }) => ({ src, in: i, len, rec, link }));
  return t;
};

beforeAll(async () => {
  execFileSync(ffmpegCommand(), [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=360x640:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", fixture,
  ]);
  const d = libraryDb();
  d.exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'ws_a', 'A', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_a', 'lib_a', 'video', 'Take', 'mem-a', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at)
      VALUES ('ver_a', 'ast_a', 1, 'libraries/lib_a/v/ver_a/source', 1, 'sha-a', 'ready', 'mem-a', 0);
  `);
  const copy = path.join(dir, "copy.mp4");
  execFileSync("cp", [fixture, copy]);
  await blobs.put("libraries/lib_a/v/ver_a/source", copy);
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("AI Editor preview", () => {
  it("scales a 4K vertical timeline to 1080x1920 and keeps a zoomed shot's picture inside the frame", () => {
    expect(previewSize({ width: 2160, height: 3840 })).toEqual({ w: 1080, h: 1920, k: 0.5 });
    expect(shotFilter(timeline(), timeline().tracks.V1.items[0]!)).toBe("scale=360:640,crop=360:640:0:0,pad=360:640:0:0:black,setsar=1,fps=30/1,format=yuv420p");
    // 1.5x: 540x960, centred then moved up 40 px: the crop starts 90 px in and 160 + 40 px down
    expect(shotFilter(timeline(), timeline().tracks.V1.items[1]!)).toMatch(/^scale=540:960,crop=360:640:90:200,pad=360:640:0:0:black,/);
  });

  it("renders as long as the timeline to the frame, and a punched-in shot differs from the same frames wide", async () => {
    const out = path.join(dir, "render.mp4");
    await renderPreview(timeline(), { ver_a: fixture }, out);
    expect(Number(ffprobe(out, "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"))).toBe(30);
    const audioS = Number(ffprobe(out, "-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "csv=p=0"));
    expect(Math.abs(audioS - 1)).toBeLessThanOrEqual(1 / 30 + 0.025); // an AAC frame of padding at most
    expect(frame(out, 5).equals(frame(out, 20))).toBe(false);
  }, 60_000);

  it("files the preview in Review, marks it made from the footage, and a re-run is the same video's next version", async () => {
    const e = (await createEdit("mem-a", { name: "Hook", sources: ["ver_a"] }))!;
    await saveDraft(e.id, "v1", { timeline: timeline(), notes: [] });
    const d = libraryDb();
    let clock = 10 ** 13;
    const run = async () => {
      enqueueJob(d, "ws_a", `${e.id}:v1`, "preview", "mem-a", true, "edit_jobs");
      // the file step waits for Review to read the new version: the clock moves on past each deferral
      for (let i = 0; i < 400; i++) {
        const left = d.prepare("SELECT 1 FROM edit_jobs WHERE edit_id = ? AND state IN ('queued', 'running')").get(e.id);
        if (!left) break;
        await tick((clock += 60_000));
        await new Promise((r) => setTimeout(r, 50));
      }
      return d.prepare("SELECT kind, state, error FROM edit_jobs WHERE edit_id = ? ORDER BY id").all(e.id);
    };
    expect(await run()).toEqual([
      { kind: "preview", state: "done", error: null },
      { kind: "file", state: "done", error: null },
    ]);
    const filed = readStep(e.id, "review")!.v1!;
    const m = (await readMeta(filed.assetId))!;
    expect(m).toMatchObject({ owner: "mem-a", name: "Hook v1" });
    expect(m.versions.map((v) => [v.n, v.status])).toEqual([[1, "ready"]]);
    expect(d.prepare("SELECT source_version_id, note FROM derived_from WHERE version_id = ?").all(m.versions[0]!.versionId!)).toEqual([
      { source_version_id: "ver_a", note: "editor" },
    ]);

    await run();
    const again = (await readMeta(filed.assetId))!;
    expect(readStep(e.id, "review")!.v1).toEqual({ assetId: filed.assetId, n: 2 });
    expect(again.versions.map((v) => v.n)).toEqual([1, 2]);
  }, 120_000);
});
