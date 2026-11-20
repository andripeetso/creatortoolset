import {
  blade, clipAt, clipsFrom, closeGap, copyOf, duplicate, endOf, find, lengthOf, lengthTo, move, paste, remove, rippleToPlayhead, setItems,
  setMark, setTrack, type Gap, type Marks, type NleItem, type NleTimeline, type PlaceMode,
} from "./model";
import { DUCK, lowerUnderVoice, measured, normalize, normTarget, soundKeys, speechSpans } from "./loudness";

// Every edit that can be made to an open timeline, by id: the keys (keys.ts), the menus and the chat's nle_run all run
// these (keys.ts commandOfKey), so a key and the chat do the same thing. A command is pure: the editor's state in, the state after it out.
// What only the page can do (play, undo, Save, tools, zoom, panels, the source viewer) is listed too, as `chat: false`,
// so every key is one command; the page does those itself.

export interface NleState {
  tl: NleTimeline;
  /** the picked clips' handles */
  sel: string[];
  /** in timeline frames */
  playhead: number;
  marks: Marks;
  /** what Paste lays (⌘C, ⌘X) */
  clipboard?: { track: string; item: NleItem }[];
  /** what a clip put on the timeline does to what is under it */
  mode?: PlaceMode;
  /** a gap picked on the timeline: either delete key closes it */
  gap?: Gap | null;
}

export interface NleParam {
  type: "number";
  about: string;
  optional?: true;
}

export interface NleCommand {
  id: string;
  title: string;
  params: Record<string, NleParam>;
  /** false: the page does it (see above); the chat never sends it */
  chat: boolean;
  enabled: (s: NleState) => boolean;
  run: (s: NleState, p: Record<string, number>) => NleState;
}

const fpsOf = (s: NleState) => s.tl.timeline.fps;
const lastFrame = (s: NleState) => Math.max(0, lengthOf(s.tl) - 1);
const any = () => true;
const picked = (s: NleState) => s.sel.length > 0;
const at = (s: NleState, playhead: number): NleState => ({ ...s, playhead: Math.max(0, Math.round(playhead)) });
const edits = (s: NleState) => [...new Set([0, ...Object.values(s.tl.tracks).flatMap((t) => t.items.flatMap((i) => [i.rec, endOf(i)]))])].sort((a, b) => a - b);
const seconds = (about: string, optional?: true): NleParam => ({ type: "number", about, ...(optional ? { optional } : {}) });

const pageOnly = (id: string, title: string): NleCommand => ({ id, title, params: {}, chat: false, enabled: any, run: (s) => s });
const cmd = (id: string, title: string, enabled: NleCommand["enabled"], run: NleCommand["run"], params: NleCommand["params"] = {}): NleCommand =>
  ({ id, title, params, chat: true, enabled, run });

const remove_ = (ripple: boolean) => (s: NleState): NleState =>
  s.gap ? { ...s, tl: closeGap(s.tl, s.gap), gap: null } : { ...s, tl: remove(s.tl, s.sel, ripple) };
const nudge = (d: number) => (s: NleState) => ({ ...s, tl: move(s.tl, s.sel, d) });
const mark = (what: Parameters<typeof setMark>[1]) => (s: NleState) => ({ ...s, marks: setMark(s.marks, what, s.playhead) });
/** A frame count from `frames`, or from `seconds` at the timeline's rate. */
const framesOf = (s: NleState, p: Record<string, number>): number => {
  if (p.frames !== undefined) return Math.round(p.frames);
  if (p.seconds !== undefined) return Math.round(p.seconds * fpsOf(s));
  throw new Error("give frames or seconds");
};

const LIST: NleCommand[] = [
  pageOnly("play", "Play / pause"),
  pageOnly("stop", "Stop"),
  pageOnly("forward", "Play forward"),
  pageOnly("reverse", "Play reverse"),
  pageOnly("save", "Save"),
  pageOnly("undo", "Undo"),
  pageOnly("redo", "Redo"),
  // the picked clips under the playhead, or (none there) every clip under it on the unlocked tracks
  cmd("split", "Split at playhead", any, (s) => {
    const under = s.sel.filter((k) => { const it = find(s.tl, k)?.item; return !!it && it.rec < s.playhead && s.playhead < endOf(it); });
    return { ...s, tl: blade(s.tl, s.playhead, under.length ? under : undefined) };
  }),
  cmd("copy", "Copy", picked, (s) => ({ ...s, clipboard: copyOf(s.tl, s.sel) })),
  cmd("cut", "Cut", picked, (s) => ({ ...s, clipboard: copyOf(s.tl, s.sel), tl: remove(s.tl, s.sel) })),
  cmd("paste", "Paste at playhead", (s) => !!s.clipboard?.length, (s) => {
    const made = paste(s.tl, s.clipboard!, s.playhead, s.mode);
    return { ...s, tl: made.tl, sel: made.keys };
  }),
  cmd("duplicate", "Duplicate", picked, (s) => {
    const made = duplicate(s.tl, s.sel);
    return { ...s, tl: made.keys.length ? made.tl : s.tl, sel: made.keys };
  }),
  cmd("selectAll", "Select all", any, (s) => ({ ...s, sel: Object.values(s.tl.tracks).flatMap((t) => t.items.map((i) => i._k!)) })),
  cmd("deselect", "Deselect all", any, (s) => ({ ...s, sel: [] })),
  cmd("selectForward", "Select clips from the playhead on", any, (s) => ({ ...s, sel: clipsFrom(s.tl, s.playhead, 1) })),
  cmd("selectBack", "Select clips up to the playhead", any, (s) => ({ ...s, sel: clipsFrom(s.tl, s.playhead, -1) })),
  // the playhead goes to the cut, where the next shot now starts
  cmd("rippleStart", "Ripple trim start to playhead", any, (s) => {
    const h = clipAt(s.tl, s.playhead, s.sel);
    const tl = rippleToPlayhead(s.tl, s.playhead, "head", s.sel);
    return { ...s, tl, playhead: h && tl !== s.tl ? h.item.rec : s.playhead };
  }),
  cmd("rippleEnd", "Ripple trim end to playhead", any, (s) => ({ ...s, tl: rippleToPlayhead(s.tl, s.playhead, "tail", s.sel) })),
  cmd("delete", "Delete (leaves a gap)", (s) => picked(s) || !!s.gap, remove_(false)),
  cmd("rippleDelete", "Ripple delete", (s) => picked(s) || !!s.gap, remove_(true)),
  cmd("enable", "Clip on / off", picked, (s) => ({ ...s, tl: setItems(s.tl, s.sel, { enabled: find(s.tl, s.sel[0])!.item.enabled === false ? undefined : false }) })),
  cmd("markIn", "Mark In at playhead", any, mark("in")),
  cmd("markOut", "Mark Out at playhead", any, mark("out")),
  cmd("clearMarks", "Clear In and Out", any, mark("clear")),
  cmd("clearIn", "Clear In", any, mark("clearIn")),
  cmd("clearOut", "Clear Out", any, mark("clearOut")),
  pageOnly("toolSelect", "Selection mode"),
  pageOnly("toolTrim", "Trim edit mode"),
  pageOnly("toolBlade", "Blade edit mode"),
  pageOnly("snap", "Snapping"),
  pageOnly("linkedSelection", "Linked selection"),
  cmd("nudgeBack", "Nudge one frame earlier", picked, nudge(-1)),
  cmd("nudgeBack5", "Nudge five frames earlier", picked, nudge(-5)),
  cmd("nudgeOn", "Nudge one frame later", picked, nudge(1)),
  cmd("nudgeOn5", "Nudge five frames later", picked, nudge(5)),
  cmd("frameBack", "Playhead one frame back", any, (s) => at(s, s.playhead - 1)),
  cmd("frameOn", "Playhead one frame on", any, (s) => at(s, s.playhead + 1)),
  cmd("secondBack", "Playhead one second back", any, (s) => at(s, s.playhead - fpsOf(s))),
  cmd("secondOn", "Playhead one second on", any, (s) => at(s, s.playhead + fpsOf(s))),
  cmd("prevEdit", "Playhead to the previous edit", any, (s) => at(s, edits(s).filter((x) => x < s.playhead).at(-1) ?? s.playhead)),
  cmd("nextEdit", "Playhead to the next edit", any, (s) => at(s, edits(s).find((x) => x > s.playhead) ?? s.playhead)),
  cmd("start", "Playhead to the start", any, (s) => at(s, 0)),
  cmd("end", "Playhead to the last frame", any, (s) => at(s, lastFrame(s))),
  pageOnly("zoomIn", "Zoom in"),
  pageOnly("zoomOut", "Zoom out"),
  pageOnly("zoomFit", "Zoom to fit"),
  pageOnly("mediaPool", "Media Pool"),
  pageOnly("inspector", "Inspector"),
  cmd("lock", "Lock / unlock a video track", any, (s, p) => {
    const id = `V${p.track}`;
    const t = s.tl.tracks[id];
    return t ? { ...s, tl: setTrack(s.tl, id, { locked: t.locked ? undefined : true }) } : s;
  }, { track: { type: "number", about: "the video track's number (3 = V3)" } }),
  pageOnly("insertEdit", "Insert from the source viewer"),
  pageOnly("overwriteEdit", "Overwrite from the source viewer"),
  pageOnly("loop", "Loop"),
  // the chat's own: what a key does by pointing and dragging
  cmd("select", "Pick the clips given in ref", any, (s) => s),
  cmd("seek", "Playhead to a time", any, (s, p) => at(s, p.seconds * fpsOf(s)), { seconds: seconds("seconds from the start") }),
  cmd("move", "Move the picked clips (and their linked clips) later, or earlier with a minus", picked, (s, p) => ({ ...s, tl: move(s.tl, s.sel, framesOf(s, p)) }), {
    frames: { type: "number", about: "frames later (minus: earlier)", optional: true },
    seconds: seconds("or seconds", true),
  }),
  // sound (loudness.ts): from what the page has measured (its menus measure first); a clip not measured is left as it is
  cmd("normalize", "Normalize Audio Levels: the picked sound clips to a loudness", (s) => soundKeys(s.tl, s.sel).some((k) => measured.has(find(s.tl, k)!.item.src)),
    (s, p) => ({ ...s, tl: normalize(s.tl, s.sel, p.target ?? normTarget(find(s.tl, soundKeys(s.tl, s.sel)[0]!)!.track), p.relative === 1) }), {
      target: { type: "number", about: "LUFS (A1 -15, A4 -30, else -14)", optional: true },
      relative: { type: "number", about: "1: one gain for all, kept level with each other", optional: true },
    }),
  cmd("lowerUnderVoice", "Lower Under Voice: a sound track's clips come down where A1 speaks, as volume keys", any, (s, p) => {
    const track = `A${p.track}`;
    if (track === "A1") throw new Error("A1 is the voice: lower another sound track under it");
    if (!s.tl.tracks[track]?.items.length) throw new Error(`${track} has no clips`);
    const spans = speechSpans(s.tl);
    // the speech is read by the track menu's Lower Under Voice…, which measures first; the chat never writes keys without it
    if (!spans.length) throw new Error("No speech on A1 is known yet: use Lower Under Voice… on the track's menu, which reads it first");
    return { ...s, tl: lowerUnderVoice(s.tl, track, spans, { amount: -Math.abs(p.amount ?? DUCK.amount), attackMs: p.attack ?? DUCK.attackMs, releaseMs: p.release ?? DUCK.releaseMs }) };
  }, {
    track: { type: "number", about: "the sound track's number (4 = A4)" },
    amount: { type: "number", about: "dB down (12)", optional: true },
    attack: { type: "number", about: "ms to come down (150)", optional: true },
    release: { type: "number", about: "ms to come back up (400)", optional: true },
  }),
  cmd("setLength", "Set the timeline's length: V1's last shot and its voice run on to it, or everything past it is cut", any,
    (s, p) => ({ ...s, tl: lengthTo(s.tl, Math.max(1, Math.round(p.seconds * fpsOf(s)))) }), { seconds: seconds("the new length in seconds") }),
];

export const COMMANDS: Record<string, NleCommand> = Object.fromEntries(LIST.map((c) => [c.id, c]));

/** The chat's command list, a line each: `id(param: about, …) title`. */
export const commandLines = (): string =>
  LIST.filter((c) => c.chat)
    .map((c) => `${c.id}${Object.keys(c.params).length ? `(${Object.entries(c.params).map(([k, v]) => `${k}${v.optional ? "?" : ""}: ${v.about}`).join(", ")})` : ""} ${c.title}`)
    .join("\n");

/** "V2:3": the third clip on V2 (by where it starts); its handle, or null. */
export function clipOfRef(tl: NleTimeline, ref: string): string | null {
  const m = /^([VA]\d+):(\d+)$/.exec(ref.trim());
  const items = m ? [...(tl.tracks[m[1]]?.items ?? [])].sort((a, b) => a.rec - b.rec) : [];
  return (m && items[Number(m[2]) - 1]?._k) ?? null;
}

export interface NleRun {
  id: string;
  params?: Record<string, unknown>;
  /** the clips the command works on, as nle_state names them ("V2:3"); picked before it runs */
  ref?: string | string[];
}

/**
 * The chat's commands run in order as one edit: all of them, or (one is wrong) none, with what was wrong. Refs are
 * read on the timeline as it was before the first command, so "V1:2" stays the same clip through the list.
 */
export function runAll(start: NleState, list: NleRun[]): NleState {
  let s = start;
  list.forEach((r, n) => {
    const c = COMMANDS[r.id];
    const no = (why: string) => new Error(`Command ${n + 1} (${r.id}): ${why}`);
    if (!c || !c.chat) throw no("not a command here");
    const p: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.params ?? {})) {
      if (!c.params[k]) throw no(`takes no ${k}`);
      if (typeof v !== "number" || !Number.isFinite(v)) throw no(`${k} is a number`);
      p[k] = v;
    }
    for (const [k, spec] of Object.entries(c.params)) if (!spec.optional && p[k] === undefined) throw no(`needs ${k}`);
    if (r.ref !== undefined) {
      const refs = Array.isArray(r.ref) ? r.ref : [r.ref];
      const keys = refs.map((x) => clipOfRef(start.tl, String(x)));
      if (keys.some((k) => !k)) throw no(`no clip ${refs[keys.indexOf(null)]}`);
      s = { ...s, sel: keys.filter((k): k is string => !!k && !!find(s.tl, k)), gap: null };
    }
    if (!c.enabled(s)) throw no("nothing to do it on: pick clips with ref (paste: copy first)");
    try {
      s = c.run(s, p);
    } catch (e) {
      throw no((e as Error).message);
    }
  });
  return { ...s, sel: s.sel.filter((k) => find(s.tl, k)) };
}

/** The timeline as the chat reads it (nle_state): seconds, clips as refs, nothing of the editor's own handles. */
export function stateView(s: NleState) {
  const fps = fpsOf(s);
  const sec = (f: number) => Math.round((f / fps) * 1000) / 1000;
  const refs = new Map<string, string>();
  const tracks = Object.fromEntries(Object.entries(s.tl.tracks).map(([id, t]) => {
    const items = [...t.items].sort((a, b) => a.rec - b.rec);
    return [id, {
      ...(t.name ? { name: t.name } : {}),
      ...(t.locked ? { locked: true } : {}),
      clips: items.map((i, n) => {
        const ref = `${id}:${n + 1}`;
        refs.set(i._k!, ref);
        const src = String(s.tl.sources[i.src]?.path ?? i.src).split("/").pop();
        return { ref, rec: sec(i.rec), len: sec(i.len), ...(typeof i.name === "string" && i.name ? { name: i.name } : {}), src, ...(i.enabled === false ? { off: true } : {}), ...(i.link !== undefined ? { link: String(i.link) } : {}) };
      }),
    }];
  }));
  return {
    fps,
    length: sec(lengthOf(s.tl)),
    playhead: sec(s.playhead),
    in: s.marks[0] === null ? null : sec(s.marks[0]),
    out: s.marks[1] === null ? null : sec(s.marks[1]),
    selection: s.sel.map((k) => refs.get(k)).filter(Boolean),
    tracks,
  };
}
