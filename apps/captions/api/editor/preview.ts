import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Item, Timeline } from "../../contracts/editor";
import { addVersion, readMeta, toLibrary } from "../review";
import { blobs, libraryDb } from "../library/db";
import { libraryRole } from "../library/access";
import { ffmpeg, ffmpegTo } from "../library/media/run";
import { Waiting } from "./analyze";
import { type Cdl, cdlFilter } from "./grade";
import { frameDuration } from "./fcpxml";
import { fitted } from "./framing";
import { editDir, gradeOf, POST_UNFINISHED, postFiles, postUnfinished, readDraft, readStep, saveStep } from "./store";
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
 * (timeline px), cut to what shows and padded black to the preview's size, at the timeline's rate, then graded (if a grade is set).
 */
export function shotFilter(tl: Timeline, item: Item, grade?: Cdl): string {
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
  const colour = cdlFilter(grade);
  return [
    `scale=${sw}:${sh}`,
    `crop=${cw}:${ch}:${cx}:${cy}`,
    `pad=${PW}:${PH}:${Math.max(0, x)}:${Math.max(0, y)}:black`,
    "setsar=1",
    `fps=${den}/${num}`,
    ...(colour ? [colour] : []),
    "format=yuv420p",
  ].join(",");
}

/** One stretch of a speaker shot: from timeline frame `at`, `frames` long; `cut` is the B-roll cutaway over it, if any. */
export interface Piece {
  at: number;
  frames: number;
  cut?: Item;
}

/**
 * The stretches of one speaker shot: his picture where no cutaway lies over it, the cutaway's where one does. The
 * cutaways are V2 items in timeline order; one that starts before the shot or runs past it is cut to the shot.
 */
export function piecesOf(shot: Item, cutaways: Item[]): Piece[] {
  const end = shot.rec + shot.len;
  const out: Piece[] = [];
  let at = shot.rec;
  for (const c of cutaways) {
    const s = Math.max(c.rec, at);
    const e = Math.min(c.rec + c.len, end);
    if (e <= s) continue;
    if (s > at) out.push({ at, frames: s - at });
    out.push({ at: s, frames: e - s, cut: c });
    at = e;
  }
  if (at < end) out.push({ at, frames: end - at });
  return out;
}

/**
 * Renders the speaker track V1 with its linked voice from A1, and the B-roll cutaways (V2) laid over it, into `out`
 * (an .mp4). A cutaway shows its own clip's picture and keeps his voice underneath, as the timeline does. `files`:
 * source key → a local file. `grade` (optional) colours his shots, not the cutaways (the Resolve grade is on V1 only).
 */
export async function renderPreview(tl: Timeline, files: Record<string, string>, out: string, signal?: AbortSignal, grade?: Cdl): Promise<void> {
  const [num, den] = frameDuration(tl.fps);
  const secs = (frames: number) => ((frames * num) / den).toFixed(6);
  const parts = `${out}.parts`;
  await rm(parts, { recursive: true, force: true });
  await mkdir(parts, { recursive: true });
  try {
    const list: string[] = [];
    // ponytail: shots are joined end to end, a gap on V1 is closed up; a draft has none (QA notes one), black fill when edits make them
    const shots = [...tl.tracks.V1.items].sort((a, b) => a.rec - b.rec);
    const cutaways = [...tl.tracks.V2.items].sort((a, b) => a.rec - b.rec);
    for (const v of shots) {
      const a = tl.tracks.A1.items.find((x) => v.link && x.link === v.link);
      const vs = tl.sources[v.src]!;
      for (const p of piecesOf(v, cutaways)) {
        if (signal?.aborted) throw new Error("Stopped");
        const seg = path.join(parts, `${String(list.length).padStart(4, "0")}.mov`);
        // seconds into the shot, which the voice and the picture both advance by
        const off = (p.at - v.rec) / tl.fps;
        const voice = a
          ? ["-ss", (a.in / tl.sources[a.src]!.fps + off).toFixed(6), "-i", files[a.src]!]
          : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"];
        const c = p.cut;
        // a cutaway's picture: its own clip from its in point, framed at zoom 1 and ungraded
        const pic = c
          ? { file: files[c.src]!, at: c.in / tl.sources[c.src]!.fps + (p.at - c.rec) / tl.fps, filter: shotFilter(tl, { ...c, zoom: 1, tilt: 0 }) }
          : { file: files[v.src]!, at: v.in / vs.fps + off, filter: shotFilter(tl, v, grade) };
        // ponytail: a linked voice from a file with no sound stream fails the render; the editor's sources are transcribed, so they have one
        await ffmpeg([
          "-ss", pic.at.toFixed(6), "-i", pic.file,
          ...voice,
          "-map", "0:v:0", "-map", "1:a:0",
          "-vf", pic.filter,
          "-af", "aresample=48000,aformat=channel_layouts=stereo",
          "-frames:v", String(p.frames), "-t", secs(p.frames),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
          "-c:a", "pcm_s16le",
          seg,
        ]);
        list.push(`file '${seg.replace(/'/g, "'\\''")}'`);
      }
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

/**
 * Local files for a timeline's sources (a bucket library's are downloaded into the library's cache once). With `editId`
 * the edit's own clips (a card, TimelineSource.file) are in the answer too; without it they are left out.
 */
export async function localFiles(tl: Timeline, editId?: string): Promise<Record<string, string>> {
  const q = libraryDb().prepare("SELECT source_key FROM asset_versions WHERE id = ?");
  const out: Record<string, string> = {};
  for (const id of Object.keys(tl.sources)) {
    const own = tl.sources[id]!.file;
    if (own) {
      if (editId) out[id] = path.join(editDir(editId), own);
      continue;
    }
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
  // a preview from an older run's copies would be filed in Review as this cut (faces unblurred, say)
  if (postUnfinished(edit.id, variant)) throw new Error(POST_UNFINISHED);
  const out = path.join(editDir(edit.id), "previews", `${variant}.mp4`);
  await mkdir(path.dirname(out), { recursive: true });
  await renderPreview(d.timeline, { ...(await localFiles(d.timeline, edit.id)), ...postFiles(edit.id, variant) }, out, signal, await gradeOf(edit.createdBy, edit.bundle));
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
