import type { Item, Timeline, TimelineSource } from "../../contracts/editor";
import { libraryDb } from "../library/db";
import { savedQuery } from "../library/collections";
import { NeedsKey } from "../library/transcribe";
import { buildAssetQuery, MAX_LIMIT, type CardRow } from "../library/query";
import type { ProbeSummary } from "../library/media/probe";
import { brollMinFrames } from "./qa";
import { readDraft, saveDraft, sourcesWorkspace } from "./store";
import { noPicture, sourceOf } from "./timeline";
import type { StepContext } from "./worker";

/**
 * The AI Editor's B-roll step: cutaways from a library collection laid over the speaker track (V2). The speaker track
 * keeps running underneath, so a cutaway never moves his voice or his cuts. The placement rules are code, not a model:
 * no cut in the hook or the CTA, every cutaway MIN..MAX long, his face between two cutaways, each cutaway ends on one
 * of his cuts, and no moment of a clip used twice. Which moment gets which clip is round-robin here: a model planner
 * can replace `pool` later.
 *
 * A cut whose takes have no picture (a voice recording, or a voice made from the script) has no face to keep: its
 * whole picture comes from the collection (placeCover), a shot per stretch of each line, from the first frame to the last.
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

/** The longest shot of a covered picture, in frames at 25 fps (3 s): a longer line is cut into equal shots. */
export const COVER_SHOT_FRAMES = 75;

/** A shot of a covered picture, with the words said under it (what its clip is matched on). */
export interface CoverWindow extends Window {
  text: string;
}

/**
 * The shots of a covered picture: every frame from 0 to the end of the voice, a cut where each line starts, and a
 * line longer than COVER_SHOT_FRAMES cut into equal shots. A line shorter than the shortest cutaway shares the shot
 * of the line before it (a short first line takes the next one in).
 */
export function coverWindows(tl: Timeline): CoverWindow[] {
  const end = Math.max(0, ...tl.tracks.V1.items.map((i) => i.rec + i.len));
  const { min } = rulesAt(tl.fps);
  const max = Math.round((COVER_SHOT_FRAMES * tl.fps) / 25);
  const marks = tl.markers.filter((m) => m.rec < end).sort((x, y) => x.rec - y.rec);
  const lines: CoverWindow[] = [];
  marks.forEach((m, k) => {
    const rec = k === 0 ? 0 : m.rec;
    const len = (marks[k + 1]?.rec ?? end) - rec;
    const prev = lines[lines.length - 1];
    if (prev && (len < min || prev.len < min)) {
      prev.len += len;
      prev.text = `${prev.text} ${m.note}`.trim();
    } else if (len > 0) lines.push({ rec, len, text: m.note });
  });
  if (!lines.length && end > 0) lines.push({ rec: 0, len: end, text: "" });
  return lines.flatMap((l) => {
    const n = Math.max(1, Math.ceil(l.len / max));
    return Array.from({ length: n }, (_, j) => {
      const at = l.rec + Math.floor((l.len * j) / n);
      return { rec: at, len: l.rec + Math.floor((l.len * (j + 1)) / n) - at, text: l.text };
    });
  });
}

/**
 * The whole picture of a cut with no picture of its own, from `pool` (a copy comes back; V1 is untouched). `rank`
 * names the clips that fit a shot's words, best first; a shot takes the best one with a moment still unused, else the
 * next clip in turn, and a clip shown less often goes before one shown more. No frame stays black: when every moment
 * is used, or no clip is as long as the shot, a moment is shown again (the note says how many) and a short clip is
 * followed by another.
 */
export function placeCover(tl: Timeline, pool: TimelineSource[], rank: (text: string) => string[] = () => []): BrollResult {
  const out = structuredClone(tl);
  const clips = pool.filter((s, k) => s.dur > 0 && s.w > 0 && pool.findIndex((o) => o.versionId === s.versionId) === k);
  if (!clips.length) {
    out.tracks.V2.items = [];
    return { timeline: out, notes: [`${BROLL_NOTE}no clip with picture in the collection`] };
  }
  const taken = new Map<string, [number, number][]>();
  const shown = (s: TimelineSource) => taken.get(s.versionId)?.length ?? 0;
  const placed: Item[] = [];
  let turn = 0;
  let again = 0;
  const take = (src: TimelineSource, start: number, w: Window) => {
    taken.set(src.versionId, [...(taken.get(src.versionId) ?? []), [start, start + Math.round((w.len * src.fps) / tl.fps)]]);
    out.sources[src.versionId] = src;
    placed.push({ src: src.versionId, in: start, len: w.len, rec: w.rec });
    turn = (clips.indexOf(src) + 1) % clips.length;
  };
  const queue = coverWindows(tl);
  for (let n = 0; n < queue.length; n++) {
    const w = queue[n]!;
    const fits = rank(w.text).flatMap((id) => clips.filter((c) => c.versionId === id));
    const rest = clips.map((_, k) => clips[(turn + k) % clips.length]!).filter((c) => !fits.includes(c));
    // sort is stable: among clips shown equally often, the best fit (then the next in turn) stays first
    const order = [...fits].sort((a, b) => shown(a) - shown(b)).concat(rest.sort((a, b) => shown(a) - shown(b)));
    const free = order.flatMap((src) => {
      const start = freeStart(taken.get(src.versionId) ?? [], Math.round((w.len * src.fps) / tl.fps), src.dur);
      return start === null ? [] : [{ src, start }];
    })[0];
    if (free) {
      take(free.src, free.start, w);
      continue;
    }
    // nothing unused is long enough: the clip with the most room (the least shown first), a moment of it again
    const src = [...order].sort((a, b) => Math.min(w.len, roomOf(b, tl.fps)) - Math.min(w.len, roomOf(a, tl.fps)))[0]!;
    const len = Math.max(1, Math.min(w.len, roomOf(src, tl.fps)));
    const frames = Math.round((len * src.fps) / tl.fps);
    // a moment its earlier shots did not start on, where the clip is long enough to have one
    const start = Math.max(0, Math.min(src.dur - frames, (shown(src) * frames) % Math.max(1, src.dur - frames + 1)));
    take(src, start, { rec: w.rec, len });
    again++;
    if (len < w.len) queue.splice(n + 1, 0, { rec: w.rec + len, len: w.len - len, text: w.text });
  }
  out.tracks.V2.items = placed;
  return { timeline: out, notes: again ? [`${BROLL_NOTE}the folder has less footage than this video is long: ${again} ${again === 1 ? "shot shows" : "shots show"} a moment again`] : [] };
}

/** A clip's whole length in timeline frames. */
const roomOf = (s: TimelineSource, fps: number) => Math.floor((s.dur * fps) / s.fps + 1e-6);

interface CollectionRow {
  id: string;
  title: string;
  probe: string | null;
}

/** A B-roll collection's clips: a folder's in its order; a smart folder's (B-roll: every clip sorted B-roll) newest MAX_LIMIT videos. */
export function brollRows(collectionId: string): CollectionRow[] {
  const d = libraryDb();
  const col = d.prepare("SELECT library_id, kind, query FROM collections WHERE id = ?").get(collectionId) as { library_id: string; kind: string; query: string | null } | undefined;
  if (col?.kind === "smart") {
    const q = buildAssetQuery(col.library_id, { ...savedQuery(JSON.parse(col.query ?? "{}")), kind: ["video"], limit: MAX_LIMIT });
    return (d.prepare(q.sql).all(...q.params) as unknown as CardRow[]).slice(0, MAX_LIMIT).map((r) => ({ id: r.version_id, title: r.title, probe: r.probe }));
  }
  return d
    .prepare(
      `SELECT v.id, a.title, v.probe FROM collection_items ci JOIN assets a ON a.id = ci.asset_id
       JOIN asset_versions v ON v.id = a.current_version_id
       WHERE ci.collection_id = ? AND a.trashed_at IS NULL ORDER BY ci.position, a.id`,
    )
    .all(collectionId) as unknown as CollectionRow[];
}

/** Why a cut with no picture waits: it has nothing to show. The step is parked (Needs setup) and Retry runs it once there is. */
export const NO_COVER = "This video has no filmed takes, so its whole picture comes from B-roll: add videos to the Media Library, or choose a B-roll folder for this edit";
export const NO_COVER_IN_FOLDER = "This video has no filmed takes, so its whole picture comes from the B-roll folder, and that folder has no video: add some, or choose another folder for this edit";

/** Every clip the library sorted as B-roll, newest first: what covers a cut with no picture when the edit names no folder. */
function sortedBroll(libraryId: string): CollectionRow[] {
  const q = buildAssetQuery(libraryId, { roll: "b", kind: ["video"], limit: MAX_LIMIT });
  return (libraryDb().prepare(q.sql).all(...q.params) as unknown as CardRow[]).slice(0, MAX_LIMIT).map((r) => ({ id: r.version_id, title: r.title, probe: r.probe }));
}

const wordsOf = (text: string): string[] => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];

/**
 * Ranks `rows` against a shot's words by their title, tags and description (the library's search text), best first.
 * A word counts for more the fewer of the clips have it, and for nothing when they all do ("the"); a clip that shares
 * no word that counts is left out.
 * ponytail: the same words, not the same meaning ("mat" never finds "mats" or "the floor"); the library's meaning search (embed.ts) or an AI picking each shot is the upgrade.
 */
export function rankByWords(rows: { id: string }[]): (text: string) => string[] {
  const d = libraryDb();
  const read = d.prepare("SELECT s.title || ' ' || s.tags || ' ' || s.description AS text FROM asset_versions v JOIN search_assets s ON s.asset_id = v.asset_id WHERE v.id = ?");
  const clips = rows.map((r) => ({ id: r.id, words: new Set(wordsOf((read.get(r.id) as { text: string } | undefined)?.text ?? "")) }));
  const weight = (w: string) => Math.log(clips.length / clips.filter((c) => c.words.has(w)).length);
  return (text) =>
    clips
      .map((c) => ({ id: c.id, score: wordsOf(text).reduce((n, w) => (c.words.has(w) ? n + weight(w) : n), 0) }))
      .filter((c) => c.score > 0)
      .sort((x, y) => y.score - x.score)
      .map((c) => c.id);
}

/** The B-roll step for one version's draft: its cutaways from the edit's collection (a cut with no picture: its whole picture), saved over the draft. */
export async function brollStep({ edit, job, variant, signal }: StepContext): Promise<void> {
  if (!variant) return; // a whole-edit step is not a draft: each version's draft queues its own
  const draft = readDraft(edit.id, variant);
  if (!draft) throw new Error(`No draft ${variant} to add B-roll to`);
  const cover = noPicture(draft.timeline);
  if (!edit.brollCollectionId && !cover) return;
  const lib = cover && !edit.brollCollectionId ? (libraryDb().prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(edit.sources[0] ?? "") as { library_id: string } | undefined) : undefined;
  const rows = edit.brollCollectionId ? brollRows(edit.brollCollectionId) : lib ? sortedBroll(lib.library_id) : [];
  // a cut with no picture and nothing to show is a black video: it waits here, in words, before a preview is made of it (Retry carries on)
  if (!rows.length && cover) throw new NeedsKey(edit.brollCollectionId ? NO_COVER_IN_FOLDER : NO_COVER);
  if (!rows.length) return;
  // read again at this step: the creator may have lost a library or the collection's footage since the edit was made
  if (sourcesWorkspace(job.actor ?? "", rows.map((r) => r.id)) !== edit.workspaceId) throw new Error("The B-roll collection is no longer yours to read");
  const pool = rows.flatMap((r) => (r.probe ? [sourceOf(r.id, r.title, JSON.parse(r.probe) as ProbeSummary)] : []));
  if (signal.aborted) return;
  const { timeline, notes } = cover ? placeCover(draft.timeline, pool, rankByWords(rows)) : placeBroll(draft.timeline, pool);
  if (cover && !timeline.tracks.V2.items.length) throw new NeedsKey(NO_COVER_IN_FOLDER);
  await saveDraft(edit.id, variant, { timeline, notes: [...draft.notes.filter((n) => !n.startsWith(BROLL_NOTE)), ...notes] });
}
