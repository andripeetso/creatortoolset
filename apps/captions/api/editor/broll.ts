import type { Item, Timeline, TimelineSource } from "../../contracts/editor";
import { libraryDb } from "../library/db";
import type { ProbeSummary } from "../library/media/probe";
import { brollMinFrames } from "./qa";
import { readDraft, saveDraft, sourcesWorkspace } from "./store";
import { sourceOf } from "./timeline";
import type { StepContext } from "./worker";

/**
 * The AI Editor's B-roll step: cutaways from a library collection laid over the speaker track (V2). The speaker track
 * keeps running underneath, so a cutaway never moves his voice or his cuts. The placement rules are code, not a model:
 * no cut in the hook or the CTA, every cutaway MIN..MAX long, his face between two cutaways, each cutaway ends on one
 * of his cuts, and no moment of a clip used twice. Which moment gets which clip is round-robin here: a model planner
 * can replace `pool` later.
 */

/** Notes this step writes start with this, so a rerun replaces them. */
export const BROLL_NOTE = "B-roll: ";

/* The rules are written in frames of a 25 fps timeline, the Python engine's; rulesAt() scales them to the timeline's rate. */
/** The hook's first frames stay on his face (about 1.5 s). */
export const HOOK_FRAMES = 37;
/** A cutaway lasts MIN to MAX frames at 25 fps (1.2 s to 2.4 s); the minimum is QA.minBrollS at any rate. */
export const MAX_SHOT_FRAMES = 60;
/** His face between two cutaways is at least this long, else the later cutaway is dropped. */
export const FACE_GAP_FRAMES = 20;

/** The placement rules in frames of a timeline at `fps`. */
export function rulesAt(fps: number) {
  const f = (n: number) => Math.round((n * fps) / 25);
  return { hook: f(HOOK_FRAMES), min: brollMinFrames(fps), max: f(MAX_SHOT_FRAMES), gap: f(FACE_GAP_FRAMES) };
}

export interface BrollResult {
  timeline: Timeline;
  notes: string[];
}

/** A cutaway's place on the timeline, in timeline frames. */
interface Window {
  rec: number;
  len: number;
}

/** The first source frame, from `from` on, where `frames` fit clear of `taken` (sorted or not) and inside `dur`; null if none does. */
export function freeStart(taken: [number, number][], frames: number, dur: number, from = 0): number | null {
  let s = from;
  for (const [a, b] of [...taken].sort((x, y) => x[0] - y[0])) {
    if (s + frames <= a) break;
    if (s < b) s = b;
  }
  return s + frames <= dur ? s : null;
}

/**
 * One cutaway over each speaker shot long enough to keep his face at its head: from the shot's head (after the face
 * gap, and never in the hook) to its cut, and never past the CTA's start. A shot too long for MAX_SHOT_FRAMES keeps
 * its cut at the end and starts later.
 */
export function windowsOf(tl: Timeline): Window[] {
  const speaker = [...tl.tracks.V1.items].sort((a, b) => a.rec - b.rec);
  const picture = Math.max(0, ...speaker.map((i) => i.rec + i.len));
  // the CTA is the last line: from its marker to the end of the picture
  const ctaFrom = tl.markers.length ? Math.max(...tl.markers.map((m) => m.rec)) : picture;
  const r = rulesAt(tl.fps);
  const wins: Window[] = [];
  for (const i of speaker) {
    const b = Math.min(i.rec + i.len, ctaFrom);
    let a = Math.max(i.rec + r.gap, r.hook);
    if (b - a > r.max) a = b - r.max;
    if (b - a < r.min) continue;
    const prev = wins[wins.length - 1];
    if (prev && a - (prev.rec + prev.len) < r.gap) continue;
    wins.push({ rec: a, len: b - a });
  }
  return wins;
}

/**
 * Lays cutaways from `pool` over the speaker track of `tl` (a copy comes back; V1 is untouched). A window no clip fits
 * (too short, or every moment of every clip already used) gets a note and no cutaway.
 */
export function placeBroll(tl: Timeline, pool: TimelineSource[]): BrollResult {
  const out = structuredClone(tl);
  const notes: string[] = [];
  const clips = pool.filter((s, k) => s.dur > 0 && s.w > 0 && pool.findIndex((o) => o.versionId === s.versionId) === k);
  if (!clips.length) {
    out.tracks.V2.items = [];
    return { timeline: out, notes: [`${BROLL_NOTE}no clip with picture in the collection`] };
  }
  const taken = new Map<string, [number, number][]>();
  const placed: Item[] = [];
  let turn = 0;
  for (const w of windowsOf(tl)) {
    let done = false;
    for (let k = 0; k < clips.length && !done; k++) {
      const src = clips[(turn + k) % clips.length]!;
      const frames = Math.round((w.len * src.fps) / tl.fps);
      const used = taken.get(src.versionId) ?? [];
      const start = freeStart(used, frames, src.dur);
      if (start === null) continue;
      taken.set(src.versionId, [...used, [start, start + frames]]);
      out.sources[src.versionId] = src;
      placed.push({ src: src.versionId, in: start, len: w.len, rec: w.rec });
      turn = (turn + k + 1) % clips.length;
      done = true;
    }
    if (!done) notes.push(`${BROLL_NOTE}no clip has a free moment long enough for the cut at ${w.rec}`);
  }
  out.tracks.V2.items = placed;
  return { timeline: out, notes };
}

interface CollectionRow {
  id: string;
  title: string;
  probe: string | null;
}

/** The B-roll step for one version's draft: its cutaways from the edit's collection, saved over the draft. */
export async function brollStep({ edit, job, variant, signal }: StepContext): Promise<void> {
  if (!variant) return; // a whole-edit step is not a draft: each version's draft queues its own
  const draft = readDraft(edit.id, variant);
  if (!draft) throw new Error(`No draft ${variant} to add B-roll to`);
  if (!edit.brollCollectionId) return;
  const rows = libraryDb()
    .prepare(
      `SELECT v.id, a.title, v.probe FROM collection_items ci JOIN assets a ON a.id = ci.asset_id
       JOIN asset_versions v ON v.id = a.current_version_id
       WHERE ci.collection_id = ? AND a.trashed_at IS NULL ORDER BY ci.position, a.id`,
    )
    .all(edit.brollCollectionId) as unknown as CollectionRow[];
  if (!rows.length) return;
  // read again at this step: the creator may have lost a library or the collection's footage since the edit was made
  if (sourcesWorkspace(job.actor ?? "", rows.map((r) => r.id)) !== edit.workspaceId) throw new Error("The B-roll collection is no longer yours to read");
  const pool = rows.flatMap((r) => (r.probe ? [sourceOf(r.id, r.title, JSON.parse(r.probe) as ProbeSummary)] : []));
  if (signal.aborted) return;
  const { timeline, notes } = placeBroll(draft.timeline, pool);
  await saveDraft(edit.id, variant, { timeline, notes: [...draft.notes.filter((n) => !n.startsWith(BROLL_NOTE)), ...notes] });
}
