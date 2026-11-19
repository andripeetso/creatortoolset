/**
 * What a person changed on a timeline by hand, in plain words for the chat: the unsaved edits while the editor is open
 * (lib/page-context), and what a save changed (a hand cut's note, a saved timeline's job), so a later turn knows what
 * they did themselves.
 */

import { describeEdit, type ItemEdit } from "./edit-timeline";

/** The most one summary says: the chat's whole page context is 2000 characters. */
const MAX = 600;

const join = (parts: string[]) => {
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const next = out ? `${out}; ${parts[i]}` : parts[i];
    if (next.length > MAX) return `${out}; and ${parts.length - i} more`;
    out = next;
  }
  return out;
};

/** Review-style edits (one per clip): "Second line on V1: taken out with its voice; Logo on V2: 0.40 s later". */
export const describeEdits = (edits: ItemEdit[], fps: number): string =>
  join(edits.map((e) => `${e.label} on ${e.key.split(":")[0]}: ${describeEdit(e, fps)}`));

interface Clip {
  src: string;
  rec: number;
  len: number;
  in: number;
  speed?: number;
  gain_db?: number;
  enabled?: boolean;
  /** the editor's own handle while it is open: the same clip on both sides */
  _k?: string;
  [k: string]: unknown;
}
/** A whole timeline as the editor holds and saves it (lib/nle/model.ts NleTimeline, a draft's EDJ). */
export interface SummaryTimeline {
  timeline: { fps: number };
  tracks: Record<string, { items: Clip[]; mute?: boolean; hidden?: boolean }>;
  sources?: Record<string, { path?: unknown; name?: unknown; fps?: number } | undefined>;
}

const LOOK = ["zoom", "pan", "tilt", "rot", "flip", "crop", "opacity"];
const FADES = ["fade_in", "fade_out"];
const differ = (a: Clip, b: Clip, keys: string[]) => keys.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

/**
 * Two versions of a whole timeline, before and after, in plain words: "V1 IMG_6940: 1.20 s off the end; V2 Logo: moved
 * to 0:06.0; 4 clips 1.20 s earlier; V3 Title: removed (was at 0:12.4)". A clip is matched by its editor handle, else by
 * the same file and the most footage in common, so a clip split or copied shows as another piece of it. "" = no change.
 */
export function describeChanges(before: SummaryTimeline, after: SummaryTimeline): string {
  const fps = after.timeline.fps || before.timeline.fps || 25;
  const sec = (f: number) => `${(Math.abs(f) / fps).toFixed(2)} s`;
  const tc = (f: number) => `${Math.floor(f / fps / 60)}:${((f / fps) % 60).toFixed(1).padStart(4, "0")}`;
  const flat = (tl: SummaryTimeline) =>
    Object.entries(tl.tracks).flatMap(([track, t]) => t.items.map((it) => ({ track, it, tl })));
  type At = ReturnType<typeof flat>[number];
  // source frames per timeline frame, and where in its file a clip starts and ends
  const rate = (x: At) => (x.it.speed ?? 1) * ((x.tl.sources?.[x.it.src]?.fps || fps) / fps);
  const span = (x: At) => [x.it.in, x.it.in + x.it.len * rate(x)];
  const common = (x: At, y: At) => Math.min(span(x)[1], span(y)[1]) - Math.max(span(x)[0], span(y)[0]);
  const name = (x: At) => {
    if (typeof x.it.line === "string" && x.it.line.trim()) return `“${x.it.line.trim().slice(0, 30)}”`;
    const s = x.tl.sources?.[x.it.src];
    const file = typeof s?.name === "string" ? s.name : typeof s?.path === "string" ? s.path : x.it.src;
    return file.replace(/\\/g, "/").split("/").pop()!.replace(/\.[^.]+$/, "") || x.it.src;
  };

  const was = flat(before);
  const now = flat(after);
  const taken = new Set<At>();
  const pairs: [At, At][] = [];
  const gone: At[] = [];
  for (const b of was) {
    let best: At | undefined;
    let most = 0;
    for (const a of now) {
      if (taken.has(a) || a.it.src !== b.it.src) continue;
      if (a.it._k && b.it._k) {
        if (a.it._k === b.it._k) { best = a; break; }
        continue;
      }
      const c = common(a, b);
      if (c > most) [best, most] = [a, c];
    }
    if (best) {
      taken.add(best);
      pairs.push([b, best]);
    } else gone.push(b);
  }

  const lines: { track: string; rec: number; text: string }[] = [];
  const say = (x: At, what: string[]) => what.length && lines.push({ track: x.track, rec: x.it.rec, text: `${x.track} ${name(x)}: ${what.join(", ")}` });
  // a clip moved, as opposed to everything after a cut moving up with it: a shift three or more clips share is said once
  const shift = (b: At, a: At) => {
    const head = Math.round((a.it.in - b.it.in) / rate(b));
    const d = a.it.rec - b.it.rec;
    return d && d !== head ? d : 0;
  };
  const shared = new Map<number, number>();
  for (const [b, a] of pairs) if (shift(b, a)) shared.set(shift(b, a), (shared.get(shift(b, a)) ?? 0) + 1);

  for (const [b, a] of pairs) {
    const what: string[] = [];
    if (a.track !== b.track) what.push(`to ${a.track}`);
    const d = shift(b, a);
    if (d && (shared.get(d) ?? 0) < 3) what.push(`moved to ${tc(a.it.rec)}`);
    const head = Math.round((a.it.in - b.it.in) / rate(b));
    if (head) what.push(head > 0 ? `${sec(head)} off the start` : `${sec(head)} more at the start`);
    const tail = Math.round((span(a)[1] - span(b)[1]) / rate(a));
    if (tail) what.push(tail < 0 ? `${sec(tail)} off the end` : `${sec(tail)} more at the end`);
    if ((a.it.speed ?? 1) !== (b.it.speed ?? 1)) what.push(`speed ${b.it.speed ?? 1}× → ${a.it.speed ?? 1}×`);
    if ((a.it.gain_db ?? 0) !== (b.it.gain_db ?? 0)) what.push(`sound ${b.it.gain_db ?? 0} → ${a.it.gain_db ?? 0} dB`);
    if (differ(a.it, b.it, LOOK)) what.push(a.it.zoom !== b.it.zoom ? `reframed (zoom ${a.it.zoom ?? 1}×)` : "reframed");
    if (differ(a.it, b.it, FADES)) what.push("fades changed");
    if ((a.it.enabled === false) !== (b.it.enabled === false)) what.push(a.it.enabled === false ? "switched off" : "switched on");
    say(a, what);
  }
  for (const [d, n] of shared) if (n >= 3) lines.push({ track: "", rec: 0, text: `${n} clips ${sec(d)} ${d < 0 ? "earlier" : "later"}` });
  for (const b of gone) say(b, [`removed (was at ${tc(b.it.rec)})`]);
  for (const a of now) {
    if (taken.has(a)) continue;
    const piece = was.some((b) => b.it.src === a.it.src && common(a, b) > 0);
    say(a, [piece ? `another piece of it at ${tc(a.it.rec)} (split or copied)` : `added at ${tc(a.it.rec)}`]);
  }
  for (const [id, t] of Object.entries(after.tracks)) {
    const o = before.tracks[id];
    if (!!t.mute !== !!o?.mute) lines.push({ track: id, rec: -1, text: `${id} ${t.mute ? "muted" : "unmuted"}` });
    if (!!t.hidden !== !!o?.hidden) lines.push({ track: id, rec: -1, text: `${id} ${t.hidden ? "hidden" : "shown"}` });
  }
  lines.sort((x, y) => x.track.localeCompare(y.track) || x.rec - y.rec);
  return join(lines.map((l) => l.text));
}
