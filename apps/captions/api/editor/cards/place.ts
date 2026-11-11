import type { Timeline, TimelineSource } from "../../../contracts/editor";
import { rulesAt } from "../broll";

/**
 * Where a card goes on the cut, in code: a full-frame cutaway on the B-roll track over the first shot of its line, by
 * the B-roll step's own rules (broll.ts): never in the hook, never over the last line, 1.2 to 2.4 s, his face at the
 * head of the shot and the cutaway ending on his cut. A cutaway covers the picture and keeps his voice (preview.ts).
 */

export interface Window {
  rec: number;
  len: number;
}

/** The room a card has over the line `lineId` (a marker's name), in timeline frames; null when there is none. */
export function cardWindow(tl: Timeline, lineId: string): Window | null {
  const at = tl.markers.find((m) => m.name === lineId)?.rec;
  const shot = tl.tracks.V1.items.find((i) => i.rec === at);
  if (!shot) return null;
  // the last line is the call to action: from its marker on, nothing covers his face
  const ctaFrom = Math.max(...tl.markers.map((m) => m.rec));
  const r = rulesAt(tl.fps);
  const b = Math.min(shot.rec + shot.len, ctaFrom);
  let a = Math.max(shot.rec + r.gap, r.hook);
  if (b - a > r.max) a = b - r.max;
  return b - a < r.min ? null : { rec: a, len: b - a };
}

export interface CardClip {
  /** the source's key on the timeline */
  key: string;
  text: string;
  /** the line it sits on, by the marker's name; null when the version no longer has its take */
  line: string | null;
  source: TimelineSource;
}

/**
 * Lays the cards over `tl` (a copy comes back; the speaker track is untouched). Cards placed before are taken off
 * first, so a version cut again gets them where its lines are now. A B-roll cutaway under a card goes. A card with no
 * room, or whose take is no longer in the version, is left out with a note.
 */
export function placeCards(tl: Timeline, cards: CardClip[]): { timeline: Timeline; notes: string[] } {
  const out = structuredClone(tl);
  const notes: string[] = [];
  const own = new Set(Object.keys(out.sources).filter((k) => out.sources[k]!.file));
  for (const k of own) delete out.sources[k];
  let v2 = out.tracks.V2.items.filter((i) => !own.has(i.src));
  const min = rulesAt(out.fps).min;
  for (const c of cards) {
    const w = c.line ? cardWindow(out, c.line) : null;
    // the clip is as long as its room was when it was drawn: it ends on his cut, as a cutaway does, however long the room is now
    const len = Math.min(w?.len ?? 0, Math.floor((c.source.dur * out.fps) / c.source.fps));
    if (!w || len < min) {
      notes.push(`no room for “${c.text}” in this cut`);
      continue;
    }
    const rec = w.rec + w.len - len;
    v2 = v2.filter((i) => i.rec + i.len <= rec || i.rec >= rec + len);
    out.sources[c.key] = c.source;
    v2.push({ src: c.key, in: 0, len, rec });
  }
  out.tracks.V2.items = v2.sort((a, b) => a.rec - b.rec);
  return { timeline: out, notes };
}
