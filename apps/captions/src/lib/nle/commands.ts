import { MARKER_COLORS, type EdjMarker, type MarkerColor, type TransType } from "@contracts/editor";
import {
  addMarker, blade, setMarker, clipAt, clipsFrom, closeGap, copyOf, duplicate, endOf, extract, find, isVideo, lengthOf, lengthTo, lift, markerAt, markersOf, move,
  freezeFrame, paste, remove, removeMarker, rippleToPlayhead, setItems, setMark, setTrack, type Gap, type Marks, type NleItem, type NleTimeline, type PlaceMode,
} from "./model";
import { DUCK, lowerUnderVoice, measured, normalize, normTarget, soundKeys, speechSpans } from "./loudness";
import { INSPECTOR_COMMANDS } from "./inspector-commands";
import { addTransition, handlesAt, removeTransition } from "./trans";
import { pendingText, placeText } from "./text-clip";
import { captionsStale } from "./captions";

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
  /** a transition picked on the timeline: the handle of the clip after its cut */
  trans?: string | null;
  /** Make or Update Captions asked for: the page sends the saved cut's render to Caption Studio (lib/nle/captions.ts) */
  captionsAsk?: "make" | "update" | null;
}

export interface NleParam {
  type: "number" | "text";
  about: string;
  optional?: true;
  /** a text param's only values */
  oneOf?: readonly string[];
}

export interface NleCommand {
  id: string;
  title: string;
  params: Record<string, NleParam>;
  /** false: the page does it (see above); the chat never sends it */
  chat: boolean;
  enabled: (s: NleState) => boolean;
  /** `t`: the text params */
  run: (s: NleState, p: Record<string, number>, t?: Record<string, string>) => NleState;
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

/** In and Out both marked: the frames from In up to the one after Out */
const range = (s: NleState): [number, number] | null =>
  s.marks[0] !== null && s.marks[1] !== null && s.marks[1] >= s.marks[0] ? [s.marks[0], s.marks[1] + 1] : null;
const transPicked = (s: NleState) => !!s.trans && !!find(s.tl, s.trans)?.item.trans;
// a picked transition, a picked gap, the picked clips, or (nothing picked, In and Out marked) the range: lift, or extract with ripple
const remove_ = (ripple: boolean) => (s: NleState): NleState => {
  if (transPicked(s)) return { ...s, tl: removeTransition(s.tl, s.trans!), trans: null };
  if (s.gap) return { ...s, tl: closeGap(s.tl, s.gap), gap: null };
  const r = range(s);
  if (!picked(s) && r) return { ...s, tl: (ripple ? extract : lift)(s.tl, r[0], r[1]) };
  return { ...s, tl: remove(s.tl, s.sel, ripple) };
};
const removable = (s: NleState) => picked(s) || !!s.gap || transPicked(s) || !!range(s);
/** A 1 s transition at the cut nearest the playhead on the picked clips' tracks (their picture tracks when any; none
 *  picked: V1); the linked sound at that cut gets a crossfade. */
const transAt = (type: TransType) => (s: NleState): NleState => {
  const on = [...new Set(s.sel.map((k) => find(s.tl, k)?.track).filter((t): t is string => !!t))];
  const tracks = on.some(isVideo) ? on.filter(isVideo) : on.length ? on : ["V1"];
  let tl = s.tl;
  for (const id of tracks) {
    const t = s.tl.tracks[id];
    const cut = t && !t.locked ? t.items.filter((i) => handlesAt(s.tl, i._k!)).sort((a, b) => Math.abs(a.rec - s.playhead) - Math.abs(b.rec - s.playhead))[0] : undefined;
    if (cut) tl = addTransition(tl, cut._k!, { ...(isVideo(id) ? { type } : {}), len: fpsOf(s) });
  }
  return { ...s, tl };
};
/** a marker's name, colour and note, as the chat gives them */
const markerText = {
  name: { type: "text", about: "its name", optional: true },
  color: { type: "text", about: "its colour", optional: true, oneOf: Object.keys(MARKER_COLORS) },
  note: { type: "text", about: "a note", optional: true },
} as const satisfies NleCommand["params"];
const markerPatch = (p: Record<string, number>, t: Record<string, string> = {}): Partial<EdjMarker> => ({
  ...(t.name !== undefined ? { name: t.name } : {}),
  ...(t.color !== undefined ? { color: t.color as MarkerColor } : {}),
  ...(t.note !== undefined ? { note: t.note } : {}),
  ...(p.frames !== undefined ? { dur: p.frames } : {}),
});
const markerTo = (dir: 1 | -1) => (s: NleState) => {
  const f = markersOf(s.tl).map((m) => m.frame).filter((x) => (dir > 0 ? x > s.playhead : x < s.playhead));
  return f.length ? at(s, dir > 0 ? f[0] : f.at(-1)!) : s;
};
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
  cmd("delete", "Delete (leaves a gap); nothing picked and In and Out marked: lift that range", removable, remove_(false)),
  cmd("rippleDelete", "Ripple delete; nothing picked and In and Out marked: extract that range", removable, remove_(true)),
  cmd("closeGap", "Close Gap", (s) => !!s.gap, (s) => ({ ...s, tl: closeGap(s.tl, s.gap!), gap: null })),
  cmd("freezeFrame", "Freeze Frame: the picked clip on V1 under the playhead holds that frame to its end", (s) => freezeFrame(s.tl, s.sel, s.playhead) !== s.tl,
    (s) => ({ ...s, tl: freezeFrame(s.tl, s.sel, s.playhead) })),
  pageOnly("changeDuration", "Change Clip Duration…"),
  pageOnly("findInMediaPool", "Find in Media Pool"),
  cmd("enable", "Clip on / off", picked, (s) => ({ ...s, tl: setItems(s.tl, s.sel, { enabled: find(s.tl, s.sel[0])!.item.enabled === false ? undefined : false }) })),
  cmd("markIn", "Mark In at playhead", any, mark("in")),
  cmd("markOut", "Mark Out at playhead", any, mark("out")),
  cmd("clearMarks", "Clear In and Out", any, mark("clear")),
  cmd("clearIn", "Clear In", any, mark("clearIn")),
  cmd("clearOut", "Clear Out", any, mark("clearOut")),
  pageOnly("toolSelect", "Selection mode"),
  pageOnly("toolTrim", "Trim edit mode"),
  pageOnly("toolBlade", "Blade edit mode"),
  pageOnly("toolSlide", "Slide edit mode"),
  pageOnly("toolStretch", "Rate stretch edit mode"),
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
  pageOnly("keyboard", "Keyboard Customization"),
  cmd("lock", "Lock / unlock a video track", any, (s, p) => {
    const id = `V${p.track}`;
    const t = s.tl.tracks[id];
    return t ? { ...s, tl: setTrack(s.tl, id, { locked: t.locked ? undefined : true }) } : s;
  }, { track: { type: "number", about: "the video track's number (3 = V3)" } }),
  pageOnly("insertEdit", "Insert from the source viewer"),
  pageOnly("overwriteEdit", "Overwrite from the source viewer"),
  pageOnly("loop", "Loop"),
  // M on a marker opens it (the page's own dialog): addMarker is off there
  cmd("addMarker", "Add a marker at the playhead", (s) => !markerAt(s.tl, s.playhead), (s, p, t) => ({ ...s, tl: addMarker(s.tl, s.playhead, markerPatch(p, t)) }), markerText),
  cmd("editMarker", "Change the marker at the playhead", (s) => !!markerAt(s.tl, s.playhead), (s, p, t) => ({ ...s, tl: setMarker(s.tl, markerAt(s.tl, s.playhead)!.frame, markerPatch(p, t)) }), {
    ...markerText, frames: { type: "number", about: "its duration in frames", optional: true },
  }),
  cmd("deleteMarker", "Delete the marker at the playhead", (s) => !!markerAt(s.tl, s.playhead), (s) => ({ ...s, tl: removeMarker(s.tl, markerAt(s.tl, s.playhead)!.frame) })),
  cmd("prevMarker", "Playhead to the previous marker", any, markerTo(-1)),
  cmd("nextMarker", "Playhead to the next marker", any, markerTo(1)),
  pageOnly("exportMarkers", "Export Markers"),
  cmd("addDissolve", "Add a 1 s cross dissolve at the cut nearest the playhead on the picked clips' tracks (none picked: V1)", any, transAt("dissolve")),
  cmd("addDipToBlack", "Add a 1 s dip to black at the cut nearest the playhead (as addDissolve)", any, transAt("dip_black")),
  cmd("addDipToWhite", "Add a 1 s dip to white at the cut nearest the playhead (as addDissolve)", any, transAt("dip_white")),
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
  // the editor makes its design (lib/nle/text-design.ts) once it is laid
  cmd("newText", "New Text: a 5 s title at the playhead, on the first free picture track above V1", any, (s, _p, t) => {
    const made = placeText(s.tl, pendingText(s.tl, t?.words ?? ""), s.playhead);
    return { ...s, tl: made.tl, sel: [made.key] };
  }, { words: { type: "text", about: "its words", optional: true } }),
  // captions are Caption Studio's (lib/nle/captions.ts): made from the saved cut's render, which the page sends
  cmd("makeCaptions", "Make Captions: the saved cut's render to Caption Studio, transcribed there, its captions on the Captions lane", (s) => !s.tl.captions,
    (s) => ({ ...s, captionsAsk: "make" })),
  cmd("updateCaptions", "Update Captions: captions from an older cut moved through the edit, only new material transcribed (save the cut first)",
    (s) => captionsStale(s.tl), (s) => ({ ...s, captionsAsk: "update" })),
  cmd("burnCaptions", "Burn in the captions on export and in the render, or not", (s) => !!s.tl.captions,
    (s, p) => ({ ...s, tl: { ...s.tl, captions: { ...s.tl.captions!, burn: p.on === undefined ? !s.tl.captions!.burn : p.on !== 0 } } }),
    { on: { type: "number", about: "1 on, 0 off (left out: switched)", optional: true } }),
  ...INSPECTOR_COMMANDS,
];

export const COMMANDS: Record<string, NleCommand> = Object.fromEntries(LIST.map((c) => [c.id, c]));

/** The chat's command list, a line each: `id(param: about, …) title`. */
export const commandLines = (): string =>
  LIST.filter((c) => c.chat)
    .map((c) => `${c.id}${Object.keys(c.params).length ? `(${Object.entries(c.params).map(([k, v]) => `${k}${v.optional ? "?" : ""}: ${v.about}${v.oneOf ? ` (${v.oneOf.join(" | ")})` : ""}`).join(", ")})` : ""} ${c.title}`)
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
    const t: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.params ?? {})) {
      const spec = c.params[k];
      if (!spec) throw no(`takes no ${k}`);
      if (spec.type === "text") {
        if (typeof v !== "string" || (spec.oneOf && !spec.oneOf.includes(v))) throw no(`${k} is ${spec.oneOf ? `one of ${spec.oneOf.join(", ")}` : "text"}`);
        t[k] = v;
      } else if (typeof v !== "number" || !Number.isFinite(v)) throw no(`${k} is a number`);
      else p[k] = v;
    }
    for (const [k, spec] of Object.entries(c.params)) if (!spec.optional && p[k] === undefined && t[k] === undefined) throw no(`needs ${k}`);
    if (r.ref !== undefined) {
      const refs = Array.isArray(r.ref) ? r.ref : [r.ref];
      const keys = refs.map((x) => clipOfRef(start.tl, String(x)));
      if (keys.some((k) => !k)) throw no(`no clip ${refs[keys.indexOf(null)]}`);
      s = { ...s, sel: keys.filter((k): k is string => !!k && !!find(s.tl, k)), gap: null };
    }
    if (!c.enabled(s)) throw no("nothing to do it on: pick clips with ref (paste: copy first)");
    try {
      s = c.run(s, p, t);
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
