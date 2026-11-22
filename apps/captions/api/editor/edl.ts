import type { Item, Timeline, TrackId } from "../../contracts/editor";

/**
 * A draft as CMX3600 EDLs, the timeline every editing app reads: one file per picture track (V1, the speaker, carries its
 * voice as "AA/V" events and the rest of A1 as audio events; V2, the B-roll, picture only). Record timecode starts at
 * 01:00:00:00, as the other exports; a source's timecode is the label its file carries at the in-point (drop frame
 * where the file's is). Each event names its clip and file in comments ("* FROM CLIP NAME", "* SOURCE FILE"), so an app relinks by
 * either. contracts/timeline-import.ts reads these back (sent-back.ts).
 *
 * An EDL has no framing, gain, markers, effects or other sound tracks.
 * shortcut: no M2 speed lines (a retimed shot spans its timeline length in the file); write M2 when an editor asks.
 */

/** frames as "HH:MM:SS:FF" at a whole-number base of `fps`; `drop`: as drop-frame timecode "HH:MM:SS;FF" (29.97, 59.94) */
export function tc(frames: number, fps: number, drop = false): string {
  const b = Math.round(fps);
  let f = Math.max(0, Math.round(frames));
  if (drop) {
    // the label skips 2 numbers (4 at 59.94) at each minute but every tenth
    const d = Math.round(b / 15);
    const per10 = b * 600 - d * 9;
    const r = f % per10;
    f += d * 9 * Math.floor(f / per10) + (r > d ? d * Math.floor((r - d) / (b * 60 - d)) : 0);
  }
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(f / (b * 3600)))}:${p(Math.floor(f / (b * 60)) % 60)}:${p(Math.floor(f / b) % 60)}${drop ? ";" : ":"}${p(f % b)}`;
}

const same = (a: Item, b: Item) => a.src === b.src && a.in === b.in && a.rec === b.rec && a.len === b.len;
const on = (tl: Timeline, t: TrackId) => (tl.tracks[t].hidden || tl.tracks[t].mute ? [] : tl.tracks[t].items.filter((i) => i.enabled !== false));

/** The picture tracks with anything on them: V1 always when it has items, V2 when it has B-roll. */
export const edlTracks = (tl: Timeline): ("V1" | "V2")[] => (["V1", "V2"] as const).filter((t) => on(tl, t).length);

/** One picture track (`track`, V1 by default) as an EDL; `files` maps each source key to its media path. */
export function toEdl(tl: Timeline, files: Record<string, string>, track: "V1" | "V2" = "V1"): string {
  const t0 = 3600 * Math.round(tl.fps);
  const pics = on(tl, track);
  const voice = track === "V1" ? on(tl, "A1") : [];
  const events = [
    ...pics.map((i) => ({ i, ch: voice.some((a) => same(a, i)) ? "AA/V" : "V" })),
    ...voice.filter((a) => !pics.some((v) => same(a, v))).map((i) => ({ i, ch: "A" })),
  ].sort((a, b) => a.i.rec - b.i.rec || (a.ch === "A" ? 1 : 0) - (b.ch === "A" ? 1 : 0));
  const out = [`TITLE: ${tl.name.replace(/[\r\n]+/g, " ")}${track === "V1" ? "" : ` ${track}`}`, "FCM: NON-DROP FRAME", ""];
  events.forEach(({ i, ch }, k) => {
    const s = tl.sources[i.src];
    const file = files[i.src];
    if (!s || !file) throw new Error(`${track}: no media for ${i.src}`);
    // the source's own timecode label at its in-point, as the file carries it; a source at another rate as its seconds
    // at the timeline's (shortcut: the label is off by the dropped numbers for a drop-frame source at another rate)
    const own = Math.abs((s.fps || tl.fps) - tl.fps) < 0.01;
    const sin = own ? s.tc + i.in : Math.round(((s.tc + i.in) / s.fps) * tl.fps);
    const drop = own && !!s.drop;
    out.push(
      `${String(k + 1).padStart(3, "0")}  AX       ${ch.padEnd(5)} C        ${tc(sin, tl.fps, drop)} ${tc(sin + i.len, tl.fps, drop)} ${tc(t0 + i.rec, tl.fps)} ${tc(t0 + i.rec + i.len, tl.fps)}`,
      `* FROM CLIP NAME: ${s.name.replace(/[\r\n]+/g, " ")}`,
      `* SOURCE FILE: ${file.replace(/[\r\n]+/g, " ")}`,
      "",
    );
  });
  return out.join("\n");
}
