import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_EYELINE, TRACKS, type Item, type Line, type Sentence, type Timeline, type TimelineSource, type TrackId, type VersionPlan } from "../../contracts/editor";
import { blobs, libraryDb } from "../library/db";
import { enqueueJob } from "../library/jobs";
import type { ProbeSummary } from "../library/media/probe";
import { wordsOf, type TimedWord } from "../library/transcribe";
import { energyOf } from "./analyze";
import { CUT, cutTake, type CutSettings } from "./cut";
import { framingOf } from "./framing";
import { draftNames, editDir, readStep, saveDraft, saveStep } from "./store";
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
  return {
    versionId,
    name,
    fps,
    tc: timecodeFrames(p.timecode, fps),
    dur: Math.round(p.duration * fps),
    w: turned ? p.height : p.width,
    h: turned ? p.width : p.height,
  };
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
  cut?: CutSettings;
}

/** Builds one version's timeline; the notes say what each line's cut removed or could not find. */
export function buildTimeline(i: BuildInput): { timeline: Timeline; notes: string[] } {
  const byN = new Map(i.sentences.map((s) => [s.n, s]));
  const text = new Map(i.lines.map((l) => [l.id, l.text]));
  const first = byN.get(i.plan.lines[0]?.take.first ?? -1);
  const lead = first ? i.sources[first.src] : undefined;
  const fps = lead?.fps || 30;
  const W = lead?.w || 1080;
  const H = lead?.h || 1920;
  const tl: Timeline = { name: i.name, fps, width: W, height: H, sources: {}, tracks: emptyTracks(), markers: [] };
  const notes: string[] = [];
  let rec = 0;
  let shot = 0;
  for (const { line, take } of i.plan.lines) {
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
    for (const [s, e] of cut.segments) {
      const len = Math.round(((e - s) * fps) / src.fps);
      if (len <= 0) continue;
      const link = `c${shot + 1}`;
      tl.tracks.V1.items.push({ src: a.src, in: s, len, rec, link, ...framingOf(shot, src, W, H, i.punch, i.eyeline[a.src] ?? DEFAULT_EYELINE) });
      tl.tracks.A1.items.push({ src: a.src, in: s, len, rec, link });
      rec += len;
      shot++;
    }
  }
  return { timeline: tl, notes };
}

interface SourceRow {
  id: string;
  title: string;
  source_key: string;
  probe: string | null;
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
  const analysis = readStep(edit.id, "analysis");
  if (!analysis) throw new Error("Analyze the footage first");
  const used = new Set(version.lines.map((l) => analysis.sentences.find((s) => s.n === l.take.first)?.src).filter((s): s is string => !!s));
  const sources: Record<string, TimelineSource> = {};
  const words: Record<string, TimedWord[]> = {};
  const energy: Record<string, Float32Array> = {};
  for (const id of used) {
    if (signal.aborted) return;
    const row = db.prepare("SELECT v.id, a.title, v.source_key, v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(id) as
      | SourceRow
      | undefined;
    const probe = row?.probe ? (JSON.parse(row.probe) as ProbeSummary) : null;
    const w = wordsOf(db, id);
    if (!row || !probe || !w) throw new Error("Some footage changed since it was analyzed: run the edit again from analyze");
    sources[id] = sourceOf(id, row.title, probe);
    words[id] = w;
    energy[id] = await energyOf(id, () => blobs.localCopy(row.source_key), signal);
  }
  const { timeline, notes } = buildTimeline({
    name: `${edit.name} ${version.name}`,
    plan: version,
    lines: plan.lines,
    sentences: analysis.sentences,
    sources,
    words,
    energy,
    punch: edit.framing.punch,
    eyeline: edit.eyeline ?? {},
    cut: edit.style?.pace === "natural" ? NATURAL_CUT : undefined,
  });
  if (!timeline.tracks.V1.items.length) throw new Error(`No speech found in ${version.title}'s takes`);
  await saveDraft(edit.id, version.name, { timeline, notes });
}
