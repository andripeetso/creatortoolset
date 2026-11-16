import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Critique } from "../../contracts/edit-plan";
import type { Item, Timeline } from "../../contracts/editor";
import { addVersion, fileTimelineView, readMeta, toLibrary } from "../review";
import { wordsOf } from "../library/transcribe";
import { draftView } from "./edits";
import { blobs, libraryDb } from "../library/db";
import { readable } from "./media";
import { libraryRole } from "../library/access";
import { ffmpeg, ffmpegTo } from "../library/media/run";
import { probe } from "../library/media/probe";
import { makeThumb } from "../library/media/thumb";
import { makeWave } from "../library/media/wave";
import { ask, onComputer, pathOf } from "../work/on-computer";
import { env } from "../lib/env";
import { Waiting } from "./analyze";
import { type Cdl, cdlFilter } from "./grade";
import { frameDuration } from "./fcpxml";
import { fitted } from "./framing";
import { renderPlanPreview } from "./plan-render";
import { type DraftFile, editDir, type EditMeta, gradeOf, ownerOf, POST_UNFINISHED, postFiles, postUnfinished, readDraft, readStep, saveFiled, saveStep } from "./store";
import type { StepContext } from "./worker";

/**
 * The AI Editor's preview: a draft rendered by the server's own ffmpeg into a watchable video, filed in Review as a
 * new version of the draft's own Review video (the first preview makes it), so reviewers comment on it there. The draft's
 * timeline goes with it (Review draws it under the player, and its hand edits can be cut into the next version). Each
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
export function shotFilter(tl: Timeline, item: Item, grade?: Cdl, band?: number): string {
  const src = tl.sources[item.src]!;
  const { w: PW, h: PH, k } = previewSize(tl);
  const f = fitted(src, tl.width, tl.height);
  const z = item.zoom ?? 1;
  const sw = even(f.w * k * z);
  const sh = even(f.h * k * z);
  // a planned shot's crop where its picture moves (item.focus), in the window it shows through: the frame, or a
  // letterbox's band of height `band`
  const wh = band ?? PH;
  const fx = item.focus && sw > PW ? item.focus.x : 0.5;
  const fy = item.focus && sh > wh ? item.focus.y : 0.5;
  const x = Math.round(sw > PW ? -(sw - PW) * fx : (PW - sw) / 2);
  const y = Math.round((sh > wh ? (PH - wh) / 2 - (sh - wh) * fy : (PH - sh) / 2) - (item.tilt ?? 0) * k);
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
  // a planned edit's shots have speeds, effects and texts, and a song under them (plan-render.ts)
  if (tl.plan) return renderPlanPreview(tl, files, out, signal, grade);
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
        // a take with no picture (a voice recording) under no cutaway: black, as a gap in the picture is
        const picture = c || vs.w > 0 ? ["-ss", pic.at.toFixed(6), "-i", pic.file] : ["-f", "lavfi", "-i", `color=c=black:s=${previewSize(tl).w}x${previewSize(tl).h}:r=${den}/${num}`];
        // ponytail: a linked voice from a file with no sound stream fails the render; the editor's sources are transcribed, so they have one
        await ffmpeg([
          ...picture,
          ...voice,
          "-map", "0:v:0", "-map", "1:a:0",
          "-vf", c || vs.w > 0 ? pic.filter : "format=yuv420p",
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

/** Said when a plug-in step would be handed a proxy: it rewrites footage, and its copies take the originals' place. */
export const onlyProxy = (title: string) => `Post-processing can't run here: this server has only the proxy of ${title}, not the original`;

/**
 * Local files for a timeline's sources (a bucket library's are downloaded into the library's cache once). With `editId`
 * the edit's own clips (a card, TimelineSource.file) are in the answer too; without it they are left out. With `proxies`
 * a source whose original is not on this server is its proxy (a render for Review); post-processing reads originals
 * only, as its copies take the originals' place in the exports: a source whose original is gone (a library that keeps
 * only proxies, worker.ts dropOriginal, where the source is the proxy) is refused (onlyProxy), never handed over as one.
 */
export async function localFiles(tl: Timeline, editId?: string, proxies = false): Promise<Record<string, string>> {
  const q = libraryDb().prepare(
    `SELECT v.source_key, a.title, d.storage_key AS proxy FROM asset_versions v JOIN assets a ON a.id = v.asset_id
     LEFT JOIN derivatives d ON d.version_id = v.id AND d.kind = 'proxy' WHERE v.id = ?`,
  );
  const out: Record<string, string> = {};
  for (const id of Object.keys(tl.sources)) {
    const own = tl.sources[id]!.file;
    if (own) {
      if (editId) out[id] = path.join(editDir(editId), own);
      continue;
    }
    // on a computer: the file the worker resolved; post takes only an original already on it (WorkFile.original)
    if (onComputer.on) {
      const f = onComputer.pkg!.files.find((x) => x.id === id);
      if (!proxies && !f?.original) throw new Error(onlyProxy(f?.title ?? id));
      out[id] = pathOf(id);
      continue;
    }
    const row = q.get(id) as { source_key: string; title: string; proxy: string | null } | undefined;
    if (!row) throw new Error("Some footage was not found in the Media Library");
    if (!proxies && row.source_key === row.proxy) throw new Error(onlyProxy(row.title));
    out[id] = await (proxies ? readable(id, row.source_key) : blobs.localCopy(row.source_key));
  }
  return out;
}

/** Where a version's preview is rendered, before Review takes it. */
export const previewFile = (editId: string, variant: string) => path.join(editDir(editId), "previews", `${variant}.mp4`);

/**
 * The preview step (one version): render, then into Review as the next version of the draft's Review video. A planned
 * cut the AI made waits for its look (critique.ts), which files it.
 */
export async function previewStep({ edit, job, variant, signal }: StepContext): Promise<void> {
  const d = readDraft(edit.id, variant);
  if (!d) throw new Error(`Draft ${variant || "the versions"} first`);
  // a preview from an older run's copies would be filed in Review as this cut (faces unblurred, say)
  if (postUnfinished(edit.id, variant)) throw new Error(POST_UNFINISHED);
  const out = previewFile(edit.id, variant);
  await mkdir(path.dirname(out), { recursive: true });
  const grade = onComputer.on ? (await ask<{ cdl?: Cdl }>("grade")).cdl : await gradeOf(ownerOf(edit), edit.bundle);
  await renderPreview(d.timeline, { ...(await localFiles(d.timeline, edit.id, true)), ...postFiles(edit.id, variant) }, out, signal, grade);
  if (signal.aborted || d.due) return;
  await fileInReview(edit, variant, d.timeline, saidOf(d), job.actor);
}

/**
 * What a draft's Review version says of the look before Review: the shots that don't hold up and, as shot 0 (no shot's
 * own line), that the look or its fix could not be made and why. Nothing for a cut that passed, or was never due one.
 */
export const saidOf = (d: Pick<DraftFile, "critique" | "unchecked">): Critique["fails"] => [...(d.critique?.fails ?? []), ...(d.unchecked ? [{ n: 0, why: d.unchecked }] : [])];

/**
 * The rendered preview into Review as the next version of the draft's Review video, with the timeline it was cut from.
 * `fails`: the shots its look found still don't hold up, named on that Review version (saidOf: and a look that was not
 * made). It is filed in the Review of the edit's workspace (ownerOf), so its owner sees and comments on a teammate's
 * edit as on their own; `by`: who asked for this version, kept on it.
 */
export async function fileInReview(edit: EditMeta, variant: string, timeline: Timeline, fails: Critique["fails"] = [], by?: string | null, given: { thumb?: string; wave?: string } = {}): Promise<void> {
  const out = previewFile(edit.id, variant);
  // on a computer: the server files it (work/result.ts), with Review's thumbnail and the library's waveform made here
  if (onComputer.on) {
    const p = await probe(out);
    const thumb = out.replace(/\.mp4$/, ".jpg");
    const wave = out.replace(/\.mp4$/, ".wave.json");
    await makeThumb(out, thumb, p.duration);
    await makeWave(out, wave, !!p.acodec);
    // paths relative to the data folder, as the result's uploads are (work/result.ts)
    onComputer.server!.review({ variant, fails, thumb: path.relative(env.dataDir, thumb), wave: path.relative(env.dataDir, wave) });
    return;
  }
  // a moment of a long recording is filed under its own title, so twenty of them in Review can be told apart
  const title = edit.moments ? readStep(edit.id, "plan")?.plans.find((p) => p.name === variant)?.title.replace(/[/\\]/g, " ") : undefined;
  // a new Review video is in the edit's workspace (a step runs outside the window's request)
  const v = { owner: ownerOf(edit), name: `${edit.name} ${title || variant}.mp4`, mime: "video/mp4", bytes: (await stat(out)).size, draft: { edit: edit.id, name: variant, ...(by ? { by } : {}), ...(fails.length ? { fails } : {}) }, workspace: edit.projectId };
  // `given`: the thumbnail and waveform made where the preview was rendered (a computer, api/work/result.ts), so Review
  // and the library take them instead of decoding the preview again
  const place = async (dest: string) => {
    await rename(out, dest);
    if (given.thumb) await rename(given.thumb, path.join(path.dirname(dest), "thumb.jpg"));
    if (given.wave) await rename(given.wave, path.join(path.dirname(dest), "wave.json"));
  };
  const filed = readStep(edit.id, "review") ?? {};
  // the same Review video every time, so a re-run is its next version; one deleted from Review gets a new video
  const added = (filed[variant] && (await addVersion(filed[variant].assetId, v, place))) || (await addVersion(undefined, v, place));
  if (!added) throw new Error("Could not file the preview in Review");
  // the timeline this version shows: kept as it is now (a later cut of the draft doesn't change what this version's keys name)
  await saveFiled(edit.id, added.meta.id, added.n, { variant, timeline });
  const db = libraryDb();
  const words = Object.fromEntries(Object.keys(timeline.sources).flatMap((id) => {
    const w = timeline.sources[id]!.file ? null : wordsOf(db, id);
    return w ? [[id, w]] : [];
  }));
  await fileTimelineView(added.meta.id, added.n, `${variant}-${added.n}.view.json`, draftView(timeline, words));
  await saveStep(edit.id, "review", { ...filed, [variant]: { assetId: added.meta.id, n: added.n, ...(by ? { by } : {}) } });
}

/**
 * The file step: once Review has the preview ready, its library version is marked as made from each source of the
 * draft the creator may still read. A Review video the library leaves out (a guest's) is fine: nothing to mark.
 */
export async function fileStep({ edit, job, variant }: StepContext): Promise<void> {
  const p = readStep(edit.id, "review")?.[variant];
  const d = readDraft(edit.id, variant);
  if (!p || !d) throw new Error("No preview in Review");
  const v = (await readMeta(p.assetId))?.versions.find((x) => x.n === p.n);
  if (!v) throw new Error("Preview not found in Review");
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
