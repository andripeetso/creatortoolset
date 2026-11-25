import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { ffmpegCommand } from "../ffmpeg-runtime";
import path from "node:path";
import type { Critique } from "../../contracts/edit-plan";
import type { Item, Renders, Timeline } from "../../contracts/editor";
import { addVersion, fileTimelineView, readMeta, setApproval, toLibrary } from "../review";
import { fileStems, stemsFor } from "./voice-mix";
import { wordsOf } from "../library/transcribe";
import { draftView } from "./edits";
import { blobs, fileBlur, isBlurred, libraryDb, playOf, SOUND_ONLY_SQL } from "../library/db";
import { readable } from "./media";
import { libraryRole } from "../library/access";
import { ffmpeg, ffmpegTo } from "../library/media/run";
import { probe } from "../library/media/probe";
import { makeThumb } from "../library/media/thumb";
import { makeWave } from "../library/media/wave";
import { ask, onComputer, pathOf } from "../work/on-computer";
import { env } from "../lib/env";
import { checkRender } from "../library/media/probe";
import { Waiting } from "./analyze";
import { type Cdl, cdlFilter } from "./grade";
import { frameDuration } from "./fcpxml";
import { fitted } from "./framing";
import { sayFor } from "./progress";
import { followPicked, HELD_NOTE } from "./subject";
import { renderPlanPreview, sfxMix } from "./plan-render";
import { cachedSegment, segDir, trimSegments } from "./segcache";
import { type DraftFile, editDir, type EditMeta, gradeOf, ownerOf, POST_UNFINISHED, postFiles, postUnfinished, readDraft, readEdit, readStep, saveDraft, saveFiled, saveStep } from "./store";
import { nextPass, PASS_WORD } from "./passes";
import { refuse, type Received } from "../library/upload-gate";
import { jobFiles } from "./reach";
import { kindOf } from "../library/routes";
import { emitEvent } from "../lib/events";
import type { StepContext } from "./worker";

/**
 * The AI Editor's preview: a draft rendered by the server's own ffmpeg into a watchable video, filed in Review as a
 * new version of the draft's own Review video (the first preview makes it), so reviewers comment on it there. The draft's
 * timeline goes with it (Review draws it under the player, and its hand edits can be cut into the next version). Each
 * speaker shot is rendered on its own (its zoom and tilt), then joined without encoding the picture again, with the
 * sound brought to -14 LUFS. The `file` step then marks the Review video's library version as made from the footage
 * (derived_from).
 */

/**
 * The highest timeline version (contracts/editor.ts edj_version) these renders take. Version 2's keys, transitions,
 * camera conversions, design clips, captions and norm_db are not drawn here yet, so the editor greys them and the save
 * refuses them. Raise it only once every version-2 field renders.
 */
export const RENDERS_EDJ = 1;

const SOUND = ["gain_db", "fade_in", "fade_out", "enabled", "mute"];
/**
 * What renderPreview (or, for a planned edit, plan-render.ts) draws of a draft, per track (contracts/editor.ts Renders):
 * the draft's GET hands it to the editor, which greys the rest, and the save refuses a timeline that adds the rest.
 * Change it with the render: a field listed here and not drawn would vanish from the render without a word.
 */
export function rendersOf(tl: Timeline): Renders {
  return {
    edj_version: RENDERS_EDJ,
    tracks: tl.plan
      ? { V1: ["zoom", "speed"], A1: ["gain_db"], A2: ["gain_db"], A3: SOUND }
      : { V1: ["zoom", "tilt", "pan", "fade_in", "fade_out", "enabled", "freeze"], V2: ["zoom", "tilt", "pan", "enabled", "hidden"], A1: SOUND, A2: SOUND, A3: SOUND },
  };
}

/** A clip's fade as an ffmpeg filter over one piece of it: the piece starts `k` frames into the clip and is `frames` long. */
export function fadeFilter(it: Pick<Item, "len" | "fade_in" | "fade_out">, k: number, frames: number, fps: number, sound = false): string[] {
  const out: string[] = [];
  const fi = it.fade_in ?? 0;
  const fo = it.fade_out ?? 0;
  // shortcut: a piece that starts inside a fade (a cutaway ended there) fades from its own start; split pieces at fades if that shows
  if (fi > k) out.push(sound ? `afade=t=in:st=0:d=${((fi - k) / fps).toFixed(6)}` : `fade=t=in:s=0:n=${fi - k}`);
  const s = it.len - fo - k;
  if (fo && s < frames) out.push(sound ? `afade=t=out:st=${(Math.max(0, s) / fps).toFixed(6)}:d=${((fo + Math.min(0, s)) / fps).toFixed(6)}` : `fade=t=out:s=${Math.max(0, s)}:n=${fo + Math.min(0, s)}`);
  return out;
}

/** The longest side of a preview: 1080x1920 from a 4K vertical timeline. */
const MAX_SIDE = 1920;
const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);

/** The preview's size: the timeline's, scaled down so its longest side is MAX_SIDE at most. */
export function previewSize(tl: Pick<Timeline, "width" | "height">): { w: number; h: number; k: number } {
  const k = Math.min(1, MAX_SIDE / Math.max(tl.width, tl.height));
  return { w: even(tl.width * k), h: even(tl.height * k), k };
}

/**
 * A reframed shot's window x (Item.path) as an ffmpeg expression of the filter's time `t`, which starts `from` seconds
 * into the item: eased from key to key as framing.ts pathAt does, a cut where two keys share a time. Commas escaped for
 * a filter chain.
 */
export function pathExpr(keys: { t: number; x: number }[], from = 0): string {
  const T = `(t+${from})`;
  let e = String(keys.at(-1)!.x);
  for (let i = keys.length - 2; i >= 0; i--) {
    const [a, b] = [keys[i]!, keys[i + 1]!];
    const u = `clip((${T}-${a.t})/${b.t - a.t},0,1)`;
    const seg = b.t > a.t && b.x !== a.x ? `(${a.x}+${Math.round((b.x - a.x) * 1e4) / 1e4}*${u}*${u}*(3-2*${u}))` : String(a.x);
    e = `if(lt(${T},${b.t}),${seg},${e})`;
  }
  return e.replace(/,/g, "\\,");
}

/**
 * The video filter for one speaker shot: the source fitted into the frame, scaled by its zoom, moved up by its tilt
 * and right by its pan (timeline px), cut to what shows and padded black to the preview's size, at the timeline's rate,
 * then graded (if a grade is set). A reframed shot's window moves along its path; `from`: seconds into the item the
 * filter's time starts at. `clear`: padded with nothing (alpha) instead of black, for a picture laid over another.
 */
export function shotFilter(tl: Timeline, item: Item, grade?: Cdl, band?: number, from = 0, clear = false): string {
  const src = tl.sources[item.src]!;
  const { w: PW, h: PH, k } = previewSize(tl);
  const f = fitted(src, tl.width, tl.height);
  const z = item.zoom ?? 1;
  const sw = even(f.w * k * z);
  const sh = even(f.h * k * z);
  // a planned shot's crop where its picture moves (item.focus), in the window it shows through: the frame, or a
  // letterbox's band of height `band`
  const wh = band ?? PH;
  const fx = item.path?.length && sw > PW ? item.path[0]!.x : item.focus && sw > PW ? item.focus.x : 0.5;
  const fy = item.focus && sh > wh ? item.focus.y : 0.5;
  const x = Math.round((sw > PW ? -(sw - PW) * fx : (PW - sw) / 2) + (item.pan ?? 0) * k);
  const y = Math.round((sh > wh ? (PH - wh) / 2 - (sh - wh) * fy : (PH - sh) / 2) - (item.tilt ?? 0) * k);
  const cx = Math.max(0, -x);
  const cy = Math.max(0, -y);
  const cw = Math.min(sw - cx, PW - Math.max(0, x));
  const ch = Math.min(sh - cy, PH - Math.max(0, y));
  const [num, den] = frameDuration(tl.fps);
  const colour = cdlFilter(grade);
  const moving = item.path && item.path.length > 1 && sw > PW;
  return [
    `scale=${sw}:${sh}`,
    moving ? `crop=${PW}:${ch}:${sw - PW}*${pathExpr(item.path!, from)}:${cy}` : `crop=${cw}:${ch}:${cx}:${cy}`,
    ...(clear ? ["format=yuva420p"] : []),
    `pad=${PW}:${PH}:${Math.max(0, x)}:${Math.max(0, y)}:${clear ? "black@0" : "black"}`,
    "setsar=1",
    `fps=${den}/${num}`,
    ...(colour ? [colour] : []),
    clear ? "format=yuva420p" : "format=yuv420p",
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

let tool: Promise<string> | null = null;
/** The encoder's version line: a cached segment another build made is not reused (segcache.ts). */
const toolVersion = () => (tool ??= promisify(execFile)(ffmpegCommand(), ["-version"]).then((r) => r.stdout.split("\n", 1)[0] ?? "", () => ""));

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
  // on the person's Mac a shot that did not change comes from the segment cache (segcache.ts)
  const cache = segDir();
  const seen = new Map<string, string>();
  const version = cache ? await toolVersion() : "";
  try {
    const list: string[] = [];
    // a clip switched off is not there; a hidden B-roll track and a muted voice track neither
    const on = (it: Item) => it.enabled !== false;
    const shots = tl.tracks.V1.items.filter(on).sort((a, b) => a.rec - b.rec);
    const cutaways = tl.tracks.V2.hidden ? [] : tl.tracks.V2.items.filter(on).sort((a, b) => a.rec - b.rec);
    // a gap on V1 (a clip taken out or switched off) is black under silence, with any cutaway over it, as the editor plays it
    const spans: Item[] = [];
    for (const v of shots) {
      const at = spans.length ? spans.at(-1)!.rec + spans.at(-1)!.len : 0;
      if (v.rec > at) spans.push({ src: "", in: 0, len: v.rec - at, rec: at });
      spans.push(v);
    }
    let heard = false;
    for (const v of spans) {
      const a = v.src && !tl.tracks.A1.mute ? tl.tracks.A1.items.find((x) => on(x) && v.link && x.link === v.link) : undefined;
      const vs = v.src ? tl.sources[v.src]! : { fps: tl.fps, w: 0 };
      heard ||= !!a;
      for (const p of piecesOf(v, cutaways)) {
        if (signal?.aborted) throw new Error("Stopped");
        // seconds into the shot, which the voice and the picture both advance by
        const off = (p.at - v.rec) / tl.fps;
        const voice = a
          ? ["-ss", (a.in / tl.sources[a.src]!.fps + off).toFixed(6), "-i", files[a.src]!]
          : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"];
        // a cutaway smaller than the frame (an intro's reaction) sits over his picture; any other takes its place
        const over = p.cut && (p.cut.zoom ?? 1) < 1 ? p.cut : undefined;
        const c = over ? undefined : p.cut;
        // a cutaway's picture: its own clip from its in point, at its own zoom and tilt, ungraded
        const pic = c
          ? { file: files[c.src]!, at: c.in / tl.sources[c.src]!.fps + (p.at - c.rec) / tl.fps, filter: shotFilter(tl, c) }
          : vs.w > 0 ? {
            file: files[v.src]!,
            // a freeze holds the shot's first frame: that one frame, repeated
            at: v.in / vs.fps + (v.freeze ? 0 : off),
            filter: [...(v.freeze ? ["trim=end_frame=1", "tpad=stop=-1:stop_mode=clone"] : []), shotFilter(tl, v, grade, undefined, off), ...fadeFilter(v, p.at - v.rec, p.frames, tl.fps)].join(","),
          } : null;
        const voiceAf = a ? [...(a.gainDb ? [`volume=${a.gainDb}dB`] : []), ...fadeFilter(a, p.at - a.rec, p.frames, tl.fps, true)] : [];
        // a take with no picture (a voice recording) under no cutaway: black, as a gap in the picture is
        const picture = pic ? ["-ss", pic.at.toFixed(6), "-i", pic.file] : ["-f", "lavfi", "-i", `color=c=black:s=${previewSize(tl).w}x${previewSize(tl).h}:r=${den}/${num}`];
        // ponytail: a linked voice from a file with no sound stream fails the render; the editor's sources are transcribed, so they have one
        const vf = pic ? pic.filter : "format=yuv420p";
        const args = [
          ...picture,
          ...voice,
          ...(over
            ? [
              "-ss", (over.in / tl.sources[over.src]!.fps + (p.at - over.rec) / tl.fps).toFixed(6), "-i", files[over.src]!,
              "-filter_complex", `[0:v]${vf}[b];[2:v]${shotFilter(tl, over, undefined, undefined, 0, true)}[o];[b][o]overlay=0:0,format=yuv420p[v]`,
              "-map", "[v]", "-map", "1:a:0",
            ]
            : ["-map", "0:v:0", "-map", "1:a:0", "-vf", vf]),
          "-af", [...voiceAf, "aresample=48000", "aformat=channel_layouts=stereo"].join(","),
          "-frames:v", String(p.frames), "-t", secs(p.frames),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
          "-c:a", "pcm_s16le",
        ];
        const inputs = [pic?.file, a ? files[a.src] : undefined, over ? files[over.src] : undefined].filter((f): f is string => !!f);
        const seg = cache
          ? await cachedSegment(cache, args, inputs, seen, (o) => ffmpeg([...args, "-f", "mov", o]), version)
          : path.join(parts, `${String(list.length).padStart(4, "0")}.mov`);
        if (!cache) await ffmpeg([...args, seg]);
        list.push(`file '${seg.replace(/'/g, "'\\''")}'`);
      }
    }
    if (!list.length) throw new Error("The draft has no speaker shots");
    const listFile = path.join(parts, "list.txt");
    await writeFile(listFile, list.join("\n"));
    // the music on A2 and the sound effects on A3 mix under the speaker's sound (sfxMix); with none the sound is levelled as before
    const sfx = sfxMix(tl, files, 1, "[0:a]", ["A2", "A3"]);
    // nothing heard at all: silence stays silence, as levelling it divides by zero (plan-render.ts does the same)
    const norm = heard || sfx ? "loudnorm=I=-14:TP=-1:LRA=11" : "anull";
    await ffmpegTo(out, [
      "-f", "concat", "-safe", "0", "-i", listFile,
      ...(sfx?.inputs ?? []),
      ...(sfx
        ? ["-filter_complex", `${sfx.filter};[sfxm]${norm}[a]`, "-map", "0:v", "-map", "[a]"]
        : ["-af", norm]),
      "-c:v", "copy", "-ar", "48000",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
    ]);
    if (cache) await trimSegments(cache).catch((e) => console.warn(`[editor] segment cache: ${e}`));
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
    // a file marked Blur faces is read as its blurred render (the editor source rule, db.ts playOf)
    const play = playOf(id);
    const row = q.get(play) as { source_key: string; title: string; proxy: string | null } | undefined;
    if (!row) throw new Error("Some footage was not found in the Media Library");
    if (!proxies && row.source_key === row.proxy) throw new Error(onlyProxy(row.title));
    out[id] = await (proxies ? readable(play, row.source_key) : blobs.localCopy(row.source_key));
  }
  return out;
}

/** Where a version's preview is rendered, before Review takes it. */
export const previewFile = (editId: string, variant: string) => path.join(editDir(editId), "previews", `${variant}.mp4`);

/** What a cut honestly is (SPEC "Honest marks"): every picture in it a blurred render, or some of it as filmed. */
export type CutMark = "blurred" | "asFilmed";

/**
 * The editor source rule (owner, 2026-11-20) for one cut of an edit: a source marked Blur faces is read as its blurred
 * render (playOf); while any has none yet the cut stops, named for the first, is never rendered from an original nor kept
 * here, and Face Blur is asked for each (library.version.blur: an old file, or one from before Face Blur was on, gets its
 * job; each is queued once). Every other file plays as filmed; a sound has no picture (db.ts BLUR_SQL reads it no). This
 * editor runs no face detection of its own. A cut that may go answers its mark, read from the cut's own sources (its
 * draft's, else the edit's): "blurred" only when every picture source is a Library file read as its blurred render;
 * anything else with a picture (a file kept as filmed, one of the edit's own, a clip no longer in the Library) "asFilmed".
 */
export function editLeaves(editId: string, variant: string): { ok: true; mark: CutMark } | Extract<Received, { ok: false }> {
  const db = libraryDb();
  const waiting = jobFiles({ version_id: `${editId}:${variant}` }).filter((r) => {
    const f = fileBlur(r.id);
    return f?.blur === "yes" && !f.blurredVersionId;
  });
  if (waiting.length) {
    const of = db.prepare("SELECT a.title, a.library_id, a.created_by FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?");
    const titles = waiting.map((r) => {
      const a = of.get(r.id) as { title: string; library_id: string; created_by: string } | undefined;
      if (a) emitEvent("library.version.blur", { libraryId: a.library_id, versionId: r.id, owner: a.created_by });
      return a?.title;
    });
    return refuse(`Waiting for blur on ${titles[0] ?? "a clip"}`);
  }
  const tl = readDraft(editId, variant)?.timeline.sources;
  const e = readEdit(editId);
  const ids = tl ? Object.keys(tl) : [...(e?.sources ?? []), ...(typeof e?.song === "string" ? [e.song] : [])];
  const soundOf = db.prepare(`SELECT ${SOUND_ONLY_SQL} AS sound FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?`);
  let pictures = 0;
  let asFilmed = false;
  for (const id of ids) {
    const own = tl?.[id]?.file;
    // a sound has no picture: an own file by its name (a voice take the editor made), a Library one by what was read in it
    const row = own ? null : (soundOf.get(id) as { sound: number } | undefined);
    if (own ? kindOf(own) === "audio" : row?.sound) continue;
    pictures++;
    // the edit's own file, or one the Library no longer has: as filmed
    if (own || !row || !isBlurred(playOf(id))) asFilmed = true;
  }
  return { ok: true, mark: pictures > 0 && !asFilmed ? "blurred" : "asFilmed" };
}

/**
 * The preview step (one version): render, then into Review as the next version of the draft's Review video. A planned
 * cut the AI made waits for its look (critique.ts), which files it.
 */
/**
 * A step of version `variant` starts (editor/worker.ts runStep on the server, work/package.ts for a computer): what its
 * pictures are made of now. Once any step of it started with something as filmed it stays so: a copy made then (a post
 * step's, a render's) may be in the cut, whatever its sources are switched to later.
 */
export function markStart(editId: string, variant: string, mark: CutMark): void {
  libraryDb()
    .prepare(
      `INSERT INTO render_marks (edit_id, variant, mark) VALUES (?, ?, ?)
       ON CONFLICT (edit_id, variant) DO UPDATE SET mark = CASE WHEN render_marks.mark = 'asFilmed' THEN 'asFilmed' ELSE excluded.mark END`,
    )
    .run(editId, variant, mark);
}

/** The mark a cut is filed with: blurred only when its steps started blurred and it still is (no start known: as filmed). */
const markOf = (editId: string, variant: string): { blurred?: true; asFilmed?: true } => {
  const left = editLeaves(editId, variant);
  if (!left.ok) return {};
  const start = (libraryDb().prepare("SELECT mark FROM render_marks WHERE edit_id = ? AND variant = ?").get(editId, variant) as { mark: CutMark } | undefined)?.mark;
  return left.mark === "blurred" && start === "blurred" ? { blurred: true } : { asFilmed: true };
};

export async function previewStep({ edit, job, variant, signal }: StepContext): Promise<void> {
  // on the server only: a computer's render is refused where its files arrive (work/result.ts)
  if (!onComputer.on) {
    const left = editLeaves(edit.id, variant);
    if (!left.ok) throw new Error(left.body.message);
  }
  let d = readDraft(edit.id, variant);
  if (!d) throw new Error(`Draft ${variant || "the versions"} first`);
  // a preview from an older run's copies would be filed in Review as this cut (faces unblurred, say)
  if (postUnfinished(edit.id, variant)) throw new Error(POST_UNFINISHED);
  const out = previewFile(edit.id, variant);
  await mkdir(path.dirname(out), { recursive: true });
  const grade = onComputer.on ? (await ask<{ cdl?: Cdl }>("grade")).cdl : await gradeOf(ownerOf(edit), edit.bundle);
  const files = await localFiles(d.timeline, edit.id, true);
  // a subject clicked in Review is followed here, on the computer that renders (subject.ts); when it can't be (no card,
  // the tracker failed: its install, the card's memory), the window stays on the click, the note says why, the cut renders
  const followed = await followPicked(d.timeline, files, signal, () => sayFor(job, "Setting up the subject tracker, the first time only (about 4 GB)")).catch((e: Error) => e);
  if (signal.aborted) return;
  const others = d.notes.filter((n) => !n.startsWith(HELD_NOTE));
  const held = followed instanceof Error ? `${HELD_NOTE} (${followed.message})` : followed === "held" ? HELD_NOTE : null;
  if (held && !d.notes.includes(held)) await saveDraft(edit.id, variant, (d = { ...d, notes: [...others, held] }));
  else if (followed && !held) await saveDraft(edit.id, variant, (d = { ...d, timeline: followed as Timeline, notes: others }));
  await renderPreview(d.timeline, { ...files, ...postFiles(edit.id, variant) }, out, signal, grade);
  // a voice the person picked plays as the sound step mixed it (voice-mix.ts; mix.m4a comes to a computer with the package)
  const stems = await stemsFor(edit, variant, d.timeline);
  if (stems && stems.set.voice !== "off" && !signal.aborted) await withMix(out, stems.dir);
  if (signal.aborted) return;
  // the joined file as Review will play it (docs/video-output-checks-prd.md §4.2): a short or silent one fails the render
  const checked = await checkRender(out, { duration: previewSeconds(d.timeline), sound: true });
  if (!checked.ok) throw new Error(checked.why);
  if (d.due) return;
  await fileInReview(edit, variant, d.timeline, saidOf(d), job.actor);
}

/** How long the joined preview is: a plan's shots one after another (plan-render.ts), else up to the last shot switched on, gaps black. */
export function previewSeconds(tl: Timeline): number {
  const [num, den] = frameDuration(tl.fps);
  const v1 = tl.tracks.V1.items;
  const frames = tl.plan ? v1.reduce((n, i) => n + i.len, 0) : Math.max(0, ...v1.filter((i) => i.enabled !== false).map((i) => i.rec + i.len));
  return (frames * num) / den;
}

/** The rendered preview's sound replaced by the voice's mix (the picture copied as it is). */
export async function withMix(video: string, dir: string): Promise<void> {
  await ffmpegTo(video, ["-i", video, "-i", path.join(dir, "mix.m4a"), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "copy", "-shortest", "-movflags", "+faststart", "-f", "mp4"]);
}

/**
 * What a draft's Review version says of the look before Review: the shots that don't hold up and, as shot 0 (no shot's
 * own line), that the look or its fix could not be made and why. Nothing for a cut that passed, or was never due one.
 */
export const saidOf = (d: Pick<DraftFile, "critique" | "unchecked">): Critique["fails"] => [...(d.critique?.fails ?? []), ...(d.unchecked ? [{ n: 0, why: d.unchecked }] : [])];
/** saidOf in the chat's words, said with the cut being ready (owner, 2026-11-16: in the chat, not as lines on the Review page). */
export function saidWords(fails: Critique["fails"]): string {
  const shots = fails.filter((f) => f.n).map((f) => `shot ${f.n} (${f.why})`);
  const list = shots.length > 1 ? `${shots.slice(0, -1).join(", ")} and ${shots.at(-1)}` : shots[0];
  return [list ? `I couldn't fix ${list}.` : "", ...fails.filter((f) => !f.n).map((f) => f.why.replace(/\.?$/, "."))].filter(Boolean).join(" ");
}

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
  // an edit in passes: approving this cut starts the version's next pass (passes.ts approvePass)
  const pass = nextPass(edit, variant);
  const title = edit.moments ? readStep(edit.id, "plan")?.plans.find((p) => p.name === variant)?.title.replace(/[/\\]/g, " ") : undefined;
  // a new Review video is in the edit's workspace (a step runs outside the window's request)
  const v = { owner: ownerOf(edit), name: `${edit.name} ${title || variant}.mp4`, mime: "video/mp4", bytes: (await stat(out)).size, draft: { edit: edit.id, name: variant, ...(by ? { by } : {}), ...(fails.length ? { fails } : {}) }, workspace: edit.projectId, ...(pass ? { next: PASS_WORD[pass] } : {}),
    // honest marks (SPEC), computed here, never a computer's word: blurred only when every picture is a blurred render;
    // a cut with nothing left to blur but some of it as filmed passes as asFilmed; one still waiting for a blur, neither
    ...markOf(edit.id, variant) };
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
  // the cut's sound in parts, for Review's voice controls (voice-mix.ts): a nicety, never a reason not to file
  await fileStems(edit, variant, timeline, added.meta.id, added.n).catch((e) => console.warn(`[editor] stems ${edit.id} ${variant}: ${e}`));
  // a new cut after Approve (its next pass) or Request changes waits for review again, as the new version it is
  if (added.n > 1 && (added.meta.approval.status === "approved" || added.meta.approval.status === "changes")) await setApproval(added.meta.id, "needs_review", ownerOf(edit));
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
