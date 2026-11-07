import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Item, Timeline } from "../../contracts/editor";
import { addVersion, readMeta, toLibrary } from "../review";
import { blobs, libraryDb } from "../library/db";
import { libraryRole } from "../library/access";
import { ffmpeg, ffmpegTo } from "../library/media/run";
import { Waiting } from "./analyze";
import { frameDuration } from "./fcpxml";
import { fitted } from "./framing";
import { editDir, readDraft, readStep, saveStep } from "./store";
import type { StepContext } from "./worker";

/**
 * The AI Editor's preview: a draft rendered by the server's own ffmpeg into a watchable video, filed in Review as a
 * new version of the draft's own Review video (the first preview makes it), so reviewers comment on it there. Each
 * speaker shot is rendered on its own (its zoom and tilt), then joined without encoding the picture again, with the
 * sound brought to -14 LUFS. The `file` step then marks the Review video's library version as made from the footage
 * (derived_from).
 */

/** The longest side of a preview: 1080x1920 from a 4K vertical timeline. */
const MAX_SIDE = 1920;
const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);

/** The preview's size: the timeline's, scaled down so its longest side is MAX_SIDE at most. */
export function previewSize(tl: Pick<Timeline, "width" | "height">): { w: number; h: number; k: number } {
  const k = Math.min(1, MAX_SIDE / Math.max(tl.width, tl.height));
  return { w: even(tl.width * k), h: even(tl.height * k), k };
}

/**
 * The video filter for one speaker shot: the source fitted into the frame, scaled by its zoom, moved up by its tilt
 * (timeline px), cut to what shows and padded black to the preview's size, at the timeline's rate.
 */
export function shotFilter(tl: Timeline, item: Item): string {
  const src = tl.sources[item.src]!;
  const { w: PW, h: PH, k } = previewSize(tl);
  const f = fitted(src, tl.width, tl.height);
  const z = item.zoom ?? 1;
  const sw = even(f.w * k * z);
  const sh = even(f.h * k * z);
  const x = Math.round((PW - sw) / 2);
  const y = Math.round((PH - sh) / 2 - (item.tilt ?? 0) * k);
  const cx = Math.max(0, -x);
  const cy = Math.max(0, -y);
  const cw = Math.min(sw - cx, PW - Math.max(0, x));
  const ch = Math.min(sh - cy, PH - Math.max(0, y));
  const [num, den] = frameDuration(tl.fps);
  return [
    `scale=${sw}:${sh}`,
    `crop=${cw}:${ch}:${cx}:${cy}`,
    `pad=${PW}:${PH}:${Math.max(0, x)}:${Math.max(0, y)}:black`,
    "setsar=1",
    `fps=${den}/${num}`,
    "format=yuv420p",
  ].join(",");
}

/** Renders the speaker track V1 with its linked voice from A1 into `out` (an .mp4). `files`: source key → a local file. */
export async function renderPreview(tl: Timeline, files: Record<string, string>, out: string, signal?: AbortSignal): Promise<void> {
  const [num, den] = frameDuration(tl.fps);
  const secs = (frames: number) => ((frames * num) / den).toFixed(6);
  const parts = `${out}.parts`;
  await rm(parts, { recursive: true, force: true });
  await mkdir(parts, { recursive: true });
  try {
    const list: string[] = [];
    // ponytail: shots are joined end to end, a gap on V1 is closed up; a draft has none (QA notes one), black fill when edits make them
    const shots = [...tl.tracks.V1.items].sort((a, b) => a.rec - b.rec);
    for (const [i, v] of shots.entries()) {
      if (signal?.aborted) throw new Error("Stopped");
      const a = tl.tracks.A1.items.find((x) => v.link && x.link === v.link);
      const vs = tl.sources[v.src]!;
      const seg = path.join(parts, `${String(i).padStart(4, "0")}.mov`);
      const voice = a
        ? ["-ss", (a.in / tl.sources[a.src]!.fps).toFixed(6), "-i", files[a.src]!]
        : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"];
      // ponytail: a linked voice from a file with no sound stream fails the render; the editor's sources are transcribed, so they have one
      await ffmpeg([
        "-ss", (v.in / vs.fps).toFixed(6), "-i", files[v.src]!,
        ...voice,
        "-map", "0:v:0", "-map", "1:a:0",
        "-vf", shotFilter(tl, v),
        "-af", "aresample=48000,aformat=channel_layouts=stereo",
        "-frames:v", String(v.len), "-t", secs(v.len),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "pcm_s16le",
        seg,
      ]);
      list.push(`file '${seg.replace(/'/g, "'\\''")}'`);
    }
    if (!list.length) throw new Error("The draft has no speaker shots");
    const listFile = path.join(parts, "list.txt");
    await writeFile(listFile, list.join("\n"));
    await ffmpegTo(out, [
      "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:v", "copy",
      "-af", "loudnorm=I=-14:TP=-1:LRA=11", "-ar", "48000",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
    ]);
  } finally {
    await rm(parts, { recursive: true, force: true });
  }
}

/** Local files for a timeline's sources (a bucket library's are downloaded into the library's cache once). */
async function localFiles(tl: Timeline): Promise<Record<string, string>> {
  const q = libraryDb().prepare("SELECT source_key FROM asset_versions WHERE id = ?");
  const out: Record<string, string> = {};
  for (const id of Object.keys(tl.sources)) {
    const row = q.get(id) as { source_key: string } | undefined;
    if (!row) throw new Error("Some footage is gone from the library");
    out[id] = await blobs.localCopy(row.source_key);
  }
  return out;
}

/** The preview step (one version): render, then into Review as the next version of the draft's Review video. */
export async function previewStep({ edit, variant, signal }: StepContext): Promise<void> {
  const d = readDraft(edit.id, variant);
  if (!d) throw new Error(`Draft ${variant || "the versions"} first`);
  const out = path.join(editDir(edit.id), "previews", `${variant}.mp4`);
  await mkdir(path.dirname(out), { recursive: true });
  await renderPreview(d.timeline, await localFiles(d.timeline), out, signal);
  if (signal.aborted) return;
  const v = { owner: edit.createdBy, name: `${edit.name} ${variant}.mp4`, mime: "video/mp4", bytes: (await stat(out)).size };
  const place = (dest: string) => rename(out, dest);
  const filed = readStep(edit.id, "review") ?? {};
  // the same Review video every time, so a re-run is its next version; one deleted from Review gets a new video
  const added = (filed[variant] && (await addVersion(filed[variant].assetId, v, place))) || (await addVersion(undefined, v, place));
  if (!added) throw new Error("Review did not take the preview");
  await saveStep(edit.id, "review", { ...filed, [variant]: { assetId: added.meta.id, n: added.n } });
}

/**
 * The file step: once Review has the preview ready, its library version is marked as made from each source of the
 * draft the creator may still read. A Review video the library leaves out (a guest's) is fine: nothing to mark.
 */
export async function fileStep({ edit, job, variant }: StepContext): Promise<void> {
  const p = readStep(edit.id, "review")?.[variant];
  const d = readDraft(edit.id, variant);
  if (!p || !d) throw new Error("No preview in Review yet");
  const v = (await readMeta(p.assetId))?.versions.find((x) => x.n === p.n);
  if (!v) throw new Error("The preview is gone from Review");
  if (v.status === "processing") throw new Waiting(10);
  if (v.status === "error") throw new Error(`Review could not read the preview: ${v.error ?? "unknown error"}`);
  await toLibrary(p.assetId); // Review mirrors it right after it is ready; this makes sure it has
  const vid = (await readMeta(p.assetId))?.versions.find((x) => x.n === p.n)?.versionId;
  const db = libraryDb();
  if (!vid || !db.prepare("SELECT 1 FROM asset_versions WHERE id = ?").get(vid)) return;
  const lib = db.prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?");
  for (const src of Object.keys(d.timeline.sources)) {
    const row = lib.get(src) as { library_id: string } | undefined;
    if (row && libraryRole(job.actor!, row.library_id)) {
      db.prepare("INSERT OR IGNORE INTO derived_from (version_id, source_version_id, note) VALUES (?, ?, 'editor')").run(vid, src);
    }
  }
}
