import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_EYELINE, MOMENT_SHAPES, TRACKS, type Item, type Line, type Sentence, type Timeline, type TimelineSource, type TrackId, type VersionPlan } from "../../contracts/editor";
import { libraryDb } from "../library/db";
import { enqueueJob } from "../library/jobs";
import type { ProbeSummary } from "../library/media/probe";
import { wordsOf, type TimedWord } from "../library/transcribe";
import { energyOf } from "./analyze";
import { CUT, cutTake, type CutSettings } from "./cut";
import { fillZoom, followPath, framingOf, reframeTimeline, speakerPath, speakerTargets, windowOf } from "./framing";
import { measurable } from "./media";
import { clearPasses, markPasses } from "./passes";
import { draftPlan } from "./plan";
import { sayFor } from "./progress";
import { facesIn, turnsOf } from "./speakers";
import { describedSeeds, faceless, subjectTargets, trackSubject } from "./subject";
import { draftNames, editDir, type EditMeta, readStep, saveDraft, saveStep } from "./store";
import type { Roll } from "./sync";
import type { StepContext } from "./worker";

/**
 * The AI Editor's draft step: one version's plan → a timeline. Each line's take is cut (cut.ts), its pieces laid end
 * to end on V1 (picture) and A1 (its own sound, linked), every other shot punched in (framing.ts), a marker per line.
 */

/**
 * The cut of an edit whose editing style says Natural pace: a pause shorter than half a second stays, and a line keeps
 * more air before and after it. Starting values nobody has measured on real footage. Every other edit gets the cut's
 * own settings (CUT), untouched.
 */
export const NATURAL_CUT: CutSettings = { ...CUT, minSilenceS: 0.5, keepTailS: 0.16, keepHeadS: 0.08, lineHeadS: 0.12, lineTailS: 0.2 };

export const TRACK_NAMES: Record<TrackId, string> = { V1: "Speaker", V2: "B-roll", A1: "Voice", A2: "Music", A3: "Sound effects" };

/** A start timecode "HH:MM:SS:FF" (";" before FF: drop frame) as frames at `fps`. */
export function timecodeFrames(tc: string | undefined, fps: number): number {
  const m = /^(\d\d):(\d\d):(\d\d)([:;])(\d\d)$/.exec(tc ?? "");
  if (!m) return 0;
  const [h, mi, s, ff] = [m[1], m[2], m[3], m[5]].map(Number) as [number, number, number, number];
  const base = Math.round(fps);
  const frames = ((h * 60 + mi) * 60 + s) * base + ff;
  if (m[4] !== ";") return frames;
  const minutes = h * 60 + mi; // drop frame: 2 numbers (4 at 59.94) skipped each minute but every tenth
  return frames - (base / 15) * (minutes - Math.floor(minutes / 10));
}

/** A library version as a timeline source, from its probe. */
export function sourceOf(versionId: string, name: string, p: ProbeSummary): TimelineSource {
  const fps = p.fps || 30;
  const turned = p.rotation === 90 || p.rotation === 270;
  // a recording whose only picture is its cover art is sound only: a cover is not a picture to show
  const [w, h] = p.cover ? [0, 0] : turned ? [p.height, p.width] : [p.width, p.height];
  return { versionId, name, fps, tc: timecodeFrames(p.timecode, fps), dur: Math.round(p.duration * fps), w, h };
}

/** A cut whose takes have no picture: nothing to cut away from, so the B-roll is the whole picture. */
export function noPicture(tl: Timeline): boolean {
  // only a take the cut knows to be sound only (w 0): a source it has no record of is not one
  const items = tl.tracks?.V1?.items ?? [];
  return items.length > 0 && items.every((i) => tl.sources?.[i.src]?.w === 0);
}

export const emptyTracks = (): Timeline["tracks"] => Object.fromEntries(TRACKS.map((t) => [t, { name: TRACK_NAMES[t], items: [] as Item[] }])) as Timeline["tracks"];

export interface BuildInput {
  name: string;
  plan: VersionPlan;
  lines: Line[];
  sentences: Sentence[];
  sources: Record<string, TimelineSource>;
  words: Record<string, TimedWord[]>;
  energy: Record<string, Float32Array>;
  punch: number;
  eyeline: Record<string, number>;
  /** per camera take, its separate mic and second cameras (sync.ts rollsOf); their sources are in `sources` */
  rolls?: Record<string, Roll>;
  cut?: CutSettings;
  /** the edit's working size (its style's); none = the first line's source's own size */
  size?: { w: number; h: number } | null;
}

/** Builds one version's timeline; the notes say what each line's cut removed or could not find. */
export function buildTimeline(i: BuildInput): { timeline: Timeline; notes: string[] } {
  const byN = new Map(i.sentences.map((s) => [s.n, s]));
  const text = new Map(i.lines.map((l) => [l.id, l.text]));
  const first = byN.get(i.plan.lines[0]?.take.first ?? -1);
  const lead = first ? i.sources[first.src] : undefined;
  const fps = lead?.fps || 30;
  const W = i.size?.w || lead?.w || 1080;
  const H = i.size?.h || lead?.h || 1920;
  const tl: Timeline = { name: i.name, fps, width: W, height: H, sources: {}, tracks: emptyTracks(), markers: [] };
  const notes: string[] = [];
  let rec = 0;
  let shot = 0;
  for (const [k, { line, take }] of i.plan.lines.entries()) {
    const a = byN.get(take.first);
    const b = byN.get(take.last);
    const src = a && i.sources[a.src];
    if (!a || !b || !src) {
      notes.push(`Line ${line}: its take is not in the footage`);
      continue;
    }
    const cut = cutTake(i.words[a.src] ?? [], a.w0, b.w1 + 1, text.get(line) ?? "", i.energy[a.src] ?? new Float32Array(), src.fps, i.cut);
    notes.push(...cut.removed.map((r) => `Line ${line}: cut ${r}`));
    if (!cut.segments.length) {
      notes.push(`Line ${line}: no speech found in take ${take.first}-${take.last}`);
      continue;
    }
    tl.sources[a.src] = src;
    tl.markers.push({ rec, name: line, color: "BLUE", note: text.get(line) ?? "" });
    const roll = i.rolls?.[a.src];
    for (const [s, e] of cut.segments) {
      const len = Math.round(((e - s) * fps) / src.fps);
      if (len <= 0) continue;
      const link = `c${shot + 1}`;
      // every other line on the second camera (a new line, a new angle; inside a line punch-ins hide the cuts), its
      // separate mic under the picture: each where it holds this stretch
      const angle = k % 2 ? along(roll?.angles?.[0], s, len, src, fps, i.sources) : null;
      const mic = along(roll?.mic, s, len, src, fps, i.sources);
      const pic = angle ?? { src: a.src, in: s };
      const ps = i.sources[pic.src]!;
      tl.sources[pic.src] = ps;
      if (mic) tl.sources[mic.src] = i.sources[mic.src]!;
      // a take with no picture (a voice recording) has nothing to punch in on
      tl.tracks.V1.items.push({ ...pic, len, rec, link, ...(ps.w ? framingOf(shot, ps, W, H, i.punch, i.eyeline[pic.src] ?? DEFAULT_EYELINE) : {}) });
      tl.tracks.A1.items.push({ ...(mic ?? { src: a.src, in: s }), len, rec, link });
      rec += len;
      shot++;
    }
  }
  return { timeline: tl, notes };
}

/**
 * Where a stretch of a camera take (`s`, its frames; `len` timeline frames) is in another recording of the same moment
 * (`at.offset_s`: seconds into it at the take's 0 s), or null when there is none or it does not hold all of it.
 */
export function along(at: { id: string; offset_s: number } | undefined, s: number, len: number, src: TimelineSource, fps: number, sources: Record<string, TimelineSource>): { src: string; in: number } | null {
  const o = at && sources[at.id];
  if (!o) return null;
  const from = Math.round((s / src.fps + at.offset_s) * o.fps);
  return from >= 0 && from + Math.round((len / fps) * o.fps) <= o.dur ? { src: at.id, in: from } : null;
}

interface SourceRow {
  id: string;
  title: string;
  source_key: string;
  probe: string | null;
}

/**
 * The stretch of its recording a reframed moment is looked at in (speakers.ts): its one take's sentences, first to last.
 * The draft step reads its faces there; engine.ts sends the step to a computer while they are not kept yet.
 */
export function reframeSpan(edit: Pick<EditMeta, "moments" | "shape">, version: VersionPlan, sentences: Sentence[]): { src: string; a: number; b: number } | null {
  const take = version.lines.length === 1 ? version.lines[0]!.take : null;
  const first = take && sentences.find((s) => s.n === take.first);
  const last = take && sentences.find((s) => s.n === take.last);
  if (!edit.moments || !edit.shape || !first || !last || first.src !== last.src) return null;
  return { src: first.src, a: Math.round(first.s * 100) / 100, b: Math.round(last.e * 100) / 100 };
}

export async function draftStep({ edit, job, variant, signal }: StepContext): Promise<void> {
  const plan = readStep(edit.id, "plan");
  if (!plan) throw new Error("Write the script first");
  const db = libraryDb();
  if (!variant) {
    // the whole edit: one draft per version planned, and drafts of versions no longer planned go, with their post copies
    const keep = new Set(plan.plans.map((p) => p.name));
    for (const n of draftNames(edit.id)) if (!keep.has(n)) await rm(path.join(editDir(edit.id), "drafts", `${n}.json`), { force: true });
    const postDir = path.join(editDir(edit.id), "post");
    for (const n of await readdir(postDir).catch(() => [])) if (!keep.has(n) && n !== "_") await rm(path.join(postDir, n), { recursive: true, force: true });
    const post = readStep(edit.id, "post");
    if (post && Object.keys(post).some((v) => v && !keep.has(v))) await saveStep(edit.id, "post", Object.fromEntries(Object.entries(post).filter(([v]) => !v || keep.has(v))));
    for (const p of plan.plans) enqueueJob(db, edit.workspaceId, `${edit.id}:${p.name}`, "draft", job.actor, true, "edit_jobs");
    return;
  }
  const version = plan.plans.find((p) => p.name === variant);
  if (!version) throw new Error(`The script has no version ${variant}`);
  // a planned version (plan.ts) has shots, not lines
  const shots = version.lines.length ? null : readStep(edit.id, "shots")?.[variant];
  if (shots) return draftPlan(edit, variant, shots, signal);
  const analysis = readStep(edit.id, "analysis");
  if (!analysis) throw new Error("Analyze the footage first");
  const used = new Set(version.lines.map((l) => analysis.sentences.find((s) => s.n === l.take.first)?.src).filter((s): s is string => !!s));
  const sources: Record<string, TimelineSource> = {};
  const words: Record<string, TimedWord[]> = {};
  const energy: Record<string, Float32Array> = {};
  const keyOf: Record<string, string> = {};
  for (const id of used) {
    if (signal.aborted) return;
    const row = db.prepare("SELECT v.id, a.title, v.source_key, v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(id) as
      | SourceRow
      | undefined;
    const probe = row?.probe ? (JSON.parse(row.probe) as ProbeSummary) : null;
    const w = wordsOf(db, id);
    if (!row || !probe || !w) throw new Error("Some footage changed since it was analyzed: run the edit again");
    sources[id] = sourceOf(id, row.title, probe);
    words[id] = w;
    keyOf[id] = row.source_key;
    energy[id] = await energyOf(id, () => measurable(id, row.source_key), signal);
  }
  // the separate mics and second cameras of the takes used: their pictures and sound only, never their words
  const rolls = analysis.rolls ?? {};
  for (const r of [...used].flatMap((id) => (rolls[id] ? [rolls[id]!] : []))) {
    for (const o of [r.mic, ...(r.angles ?? [])]) {
      const row = o && (db.prepare("SELECT v.id, a.title, v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(o.id) as SourceRow | undefined);
      if (row?.probe) sources[row.id] = sourceOf(row.id, row.title, JSON.parse(row.probe) as ProbeSummary);
    }
  }
  const shape = edit.moments && edit.shape && Object.values(sources).some((x) => x.w > 0) ? MOMENT_SHAPES[edit.shape] : null;
  const built = buildTimeline({
    name: `${edit.name} ${version.name}`,
    plan: version,
    lines: plan.lines,
    sentences: analysis.sentences,
    sources,
    words,
    energy,
    punch: edit.framing.punch,
    eyeline: { ...analysis.eyeline, ...edit.eyeline },
    rolls,
    cut: edit.style?.pace === "natural" ? NATURAL_CUT : undefined,
    // a moment of a long recording keeps the recording's own shape (fitted into another frame it would be a small picture
    // between bars), or is reframed to the shape asked for, the picture following who talks
    size: edit.moments && Object.values(sources).some((x) => x.w > 0) ? shape : edit.size,
  });
  const { notes } = built;
  let timeline = built.timeline;
  const span = shape && reframeSpan(edit, version, analysis.sentences);
  if (span && sources[span.src]?.w) {
    const src = sources[span.src]!;
    const win = windowOf(src, shape.w, shape.h, fillZoom(src, shape.w, shape.h));
    let follow: Parameters<typeof reframeTimeline>[1] = {};
    try {
      const frames = await facesIn(span.src, () => measurable(span.src, keyOf[span.src]!), span.a, span.b, src, signal);
      const said = words[span.src]!.filter((w) => w.e > span.a && w.s < span.b);
      const { turns, tracks } = turnsOf(frames, said);
      // and each speaker followed alone, for Review's reframe
      const speakers = Object.fromEntries(Object.entries(tracks).map(([n, ids]) => [n, speakerPath(frames, ids, win)]).filter(([, k]) => k.length));
      follow = { [span.src]: { keys: followPath(speakerTargets(frames, turns, tracks, win), win), turns, speakers } };
      // no faces to follow (game capture, a product, someone turned away): the subject its look names (subject.ts)
      const seeds = faceless(frames) ? describedSeeds(db, span.src, span.a, span.b) : [];
      if (seeds.length) {
        const say = () => sayFor(job, "Setting up the subject tracker, the first time only (about 4 GB)");
        const got = await trackSubject(span.src, () => measurable(span.src, keyOf[span.src]!), span.a, span.b, src.fps, seeds, signal, say).catch((e: Error) => e);
        if (got instanceof Error) {
          if (signal.aborted) return;
          notes.push(`The picture stays in the middle: its subject could not be followed (${got.message})`);
        } else if (got) follow = { [span.src]: { keys: followPath(subjectTargets(got), win) } };
        else notes.push("The picture stays in the middle: following what is in it takes a computer with an NVIDIA graphics card");
      }
    } catch (e) {
      if (signal.aborted) return;
      notes.push(`The picture stays in the middle: who talks could not be found (${(e as Error).message})`);
    }
    timeline = reframeTimeline(timeline, follow);
  }
  if (!timeline.tracks.V1.items.length) throw new Error(`No speech found in ${version.title}'s takes`);
  // a cut the AI made: looked at and checked before Review (critique.ts)
  await saveDraft(edit.id, version.name, { timeline, notes, due: 1 });
  await clearPasses(edit.id, version.name); // cut again: its passes start over
  // a cut with no picture: its B-roll is its picture, laid with the first cut and never a pass to wait for (engine.ts nextFor)
  if (edit.style?.passes && noPicture(timeline)) await markPasses(edit.id, { [version.name]: "broll" });
}
