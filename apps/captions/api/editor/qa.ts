import type { Item, QaReport, Timeline, TrackId } from "../../contracts/editor";
import { fitted, tiltLimit } from "./framing";

/** Checks on a draft, pure. Starting values: per edit later; failures are notes, never a block. */
export const QA = {
  /** a speaker shot shorter than this (timeline frames) reads as a flash */
  minSpeakerFrames: 13,
  minBrollFrames: 6,
  /** versions may share this much of a version's voice frames, in percent */
  maxSharedPct: 20,
  /** and no run of shared voice longer than this */
  maxSharedRunS: 5,
};

const end = (i: Item) => i.rec + i.len;
const fmt = (n: number) => String(Math.round(n * 10) / 10);

/** Source-frame ranges an A1 track plays, merged per source: what "the same voice" is measured on. */
function voiceOf(tl: Timeline): Map<string, [number, number][]> {
  const by = new Map<string, [number, number][]>();
  for (const i of tl.tracks.A1.items) {
    const sfps = tl.sources[i.src]?.fps ?? tl.fps;
    const r: [number, number] = [i.in, i.in + Math.round((i.len * sfps) / tl.fps)];
    by.set(i.src, [...(by.get(i.src) ?? []), r]);
  }
  for (const [src, rs] of by) {
    rs.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const r of rs) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    by.set(src, merged);
  }
  return by;
}

/** The voice `a` shares with `b`: share of a's voice frames (percent) and the longest shared run (seconds of source). */
export function sharedVoice(a: Timeline, b: Timeline): { pct: number; longestS: number } {
  const va = voiceOf(a);
  const vb = voiceOf(b);
  let total = 0;
  let shared = 0;
  let longestS = 0;
  for (const [src, ra] of va) {
    const fps = a.sources[src]?.fps ?? a.fps;
    for (const [s, e] of ra) {
      total += e - s;
      for (const [s2, e2] of vb.get(src) ?? []) {
        const n = Math.min(e, e2) - Math.max(s, s2);
        if (n <= 0) continue;
        shared += n;
        longestS = Math.max(longestS, n / fps);
      }
    }
  }
  return { pct: total ? (shared / total) * 100 : 0, longestS };
}

/** Gaps and overlaps on a track that must play without a break. */
function breaks(tl: Timeline, t: TrackId): string[] {
  const out: string[] = [];
  let at = 0;
  for (const i of [...tl.tracks[t].items].sort((a, b) => a.rec - b.rec)) {
    if (i.rec > at) out.push(`${t}: a gap of ${i.rec - at} frames at ${at}`);
    if (i.rec < at) out.push(`${t}: two clips overlap at ${i.rec}`);
    at = Math.max(at, end(i));
  }
  return out;
}

/** Every check on `tl`; `others` are the edit's other versions, by name, for the shared-voice check. */
export function qaOf(tl: Timeline, others: Record<string, Timeline> = {}): QaReport {
  const notes = [...breaks(tl, "V1"), ...breaks(tl, "A1")];
  for (const i of tl.tracks.V1.items) if (i.len < QA.minSpeakerFrames) notes.push(`V1: a ${i.len}-frame speaker shot at ${i.rec} (under ${QA.minSpeakerFrames})`);
  for (const i of tl.tracks.V2.items) if (i.len < QA.minBrollFrames) notes.push(`V2: a ${i.len}-frame B-roll shot at ${i.rec} (under ${QA.minBrollFrames})`);
  for (const t of ["V1", "V2"] as const) {
    for (const i of tl.tracks[t].items) {
      const src = tl.sources[i.src];
      if (!src || !i.tilt) continue;
      if (Math.abs(i.tilt) > tiltLimit(fitted(src, tl.width, tl.height).h, tl.height, i.zoom ?? 1) + 0.5) notes.push(`${t}: the picture at ${i.rec} is moved past its edge`);
    }
  }
  const picture = Math.max(0, ...tl.tracks.V1.items.map(end), ...tl.tracks.V2.items.map(end));
  const sound = Math.max(0, ...(["A1", "A2", "A3"] as const).flatMap((t) => tl.tracks[t].items.map(end)));
  if (sound > picture) notes.push(`The last ${sound - picture} frames have sound over black`);
  const shared: QaReport["shared"] = [];
  for (const [name, other] of Object.entries(others)) {
    const s = sharedVoice(tl, other);
    if (!s.pct) continue;
    shared.push({ with: name, pct: Math.round(s.pct * 10) / 10, longestS: Math.round(s.longestS * 100) / 100 });
    if (s.pct > QA.maxSharedPct) notes.push(`Shares ${fmt(s.pct)} % of its voice with ${name} (over ${QA.maxSharedPct} %)`);
    if (s.longestS > QA.maxSharedRunS) notes.push(`Shares a ${fmt(s.longestS)} s run of voice with ${name} (over ${QA.maxSharedRunS} s)`);
  }
  return { ok: !notes.length, notes, shared };
}
