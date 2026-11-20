import { KEY_EASES, KEY_PROPS, TRANS_TYPES, type EdjCamera, type EdjTrans, type KeyEase, type KeyProp } from "@contracts/editor";
import { PROFILES } from "@contracts/camera";
import { delKey, keysIn, setKey } from "./keyframes";
import { addTransition, setTransition } from "./trans";
import { find, isVideo, setItems, withLinked, type NleTimeline } from "./model";
import type { NleCommand, NleState } from "./commands";

// The Inspector's edits as registry commands (commands.ts lists them): keyframes, a picked transition, the camera
// conversion of the picked clips' files. Kept apart so the registry's own list stays the keys'.

const cmd = (id: string, title: string, enabled: NleCommand["enabled"], run: NleCommand["run"], params: NleCommand["params"] = {}): NleCommand =>
  ({ id, title, params, chat: true, enabled, run });
const prop = { type: "text", about: "what is keyed", oneOf: KEY_PROPS } as const;
const picked = (s: NleState) => s.sel.length > 0;

/** the timeline frames of the picked clips' keys of `p`, whole frames, in order */
const keyFrames = (s: NleState, p: KeyProp) => [...new Set(s.sel.flatMap((k) => keysIn(s.tl, k, p).map((x) => Math.round(x.f))))].sort((a, b) => a - b);
/** the picked clips with a key of `p` on the playhead */
export const onKey = (s: Pick<NleState, "tl" | "sel" | "playhead">, p: KeyProp) =>
  s.sel.filter((k) => keysIn(s.tl, k, p).some((x) => Math.abs(x.f - s.playhead) < 1e-2));
/** the clip whose transition is picked: the one picked on the timeline, else the first picked clip with one */
export const transOf = (s: Pick<NleState, "tl" | "sel" | "trans">) => {
  const k = s.trans ?? s.sel[0];
  return k && find(s.tl, k)?.item.trans ? k : null;
};

/** The picked clips' sound clips at the same cut as video clip `k` (a transition's "Cross-fade sound"). */
export const soundsAtCut = (tl: NleTimeline, k: string) => {
  const hit = find(tl, k);
  return hit && isVideo(hit.track) ? withLinked(tl, [k]).filter((x) => { const h = find(tl, x)!; return !isVideo(h.track) && h.item.rec === hit.item.rec; }) : [];
};

/** The camera a pick gives a source (`pick`: none, file, a PROFILES id or a LUT's id); undefined: the pick does not fit. */
export function cameraOf(was: EdjCamera | undefined, pick: string): EdjCamera | undefined {
  if (pick === "none") return was && { ...was, on: false };
  if (pick === "file") return was?.from === "file" && was.curve ? { curve: was.curve, from: "file", on: true } : undefined;
  // shortcut: a curve or LUT picked by hand forgets what the file said (the EDJ has one curve a source); upgrade if he misses the row
  if (pick in PROFILES) return { curve: pick, on: true };
  if (/^lut_[\w-]+$/.test(pick)) return { lut: pick, on: true };
  return undefined;
}

export const INSPECTOR_COMMANDS: NleCommand[] = [
  cmd("key", "Keyframe", picked, (s, p, t = {}) => {
    let tl = s.tl;
    for (const k of s.sel) tl = setKey(tl, k, t.prop as KeyProp, s.playhead, p.value, t.ease as KeyEase | undefined);
    return { ...s, tl };
  }, {
    prop,
    value: { type: "number", about: "its value (zoom 1 = fit, pan/tilt px, rot degrees, opacity 0–1, gain_db dB); the value there now when left out", optional: true },
    ease: { type: "text", about: "how it goes on to the next key", oneOf: KEY_EASES, optional: true },
  }),
  cmd("deleteKey", "Delete keyframe", () => true, (s, _p, t = {}) => {
    let tl = s.tl;
    for (const k of onKey(s, t.prop as KeyProp)) tl = delKey(tl, k, t.prop as KeyProp, s.playhead);
    return { ...s, tl };
  }, { prop }),
  cmd("prevKey", "Playhead to the previous keyframe", picked, (s, _p, t = {}) =>
    ({ ...s, playhead: keyFrames(s, t.prop as KeyProp).filter((f) => f < s.playhead).at(-1) ?? s.playhead }), { prop }),
  cmd("nextKey", "Playhead to the next keyframe", picked, (s, _p, t = {}) =>
    ({ ...s, playhead: keyFrames(s, t.prop as KeyProp).find((f) => f > s.playhead) ?? s.playhead }), { prop }),
  // length and alignment go to the linked clips' transitions at the cut too (setTransition); every edit clamps to the handles
  cmd("transition", "Transition", (s) => !!transOf(s), (s, p, t = {}) => {
    const k = transOf(s)!;
    const patch: Partial<EdjTrans> = {
      ...(t.type ? { type: t.type as EdjTrans["type"] } : {}),
      ...(p.frames !== undefined ? { len: Math.max(1, Math.round(p.frames)) } : {}),
      ...(t.at ? { at: t.at as EdjTrans["at"] } : {}),
    };
    let tl = setTransition(s.tl, k, patch);
    const sounds = soundsAtCut(tl, k);
    if (p.sound === 1 && !sounds.some((x) => find(tl, x)!.item.trans)) tl = addTransition(tl, k, find(tl, k)!.item.trans);
    if (p.sound === 0) tl = setItems(tl, sounds.filter((x) => find(tl, x)!.item.trans), { trans: undefined });
    return { ...s, tl };
  }, {
    type: { type: "text", about: "what it does", oneOf: TRANS_TYPES, optional: true },
    frames: { type: "number", about: "its length in frames (as long as the clips' handles allow)", optional: true },
    at: { type: "text", about: "centred on the cut, starting on it or ending on it", oneOf: ["center", "start", "end"], optional: true },
    sound: { type: "number", about: "1: the linked sound cross-fades with it, 0: it does not", optional: true },
  }),
  // per source by design: every clip of the file gets it
  cmd("camera", "Camera conversion", picked, (s, _p, t = {}) => {
    const sources = { ...s.tl.sources };
    for (const k of s.sel) {
      const src = find(s.tl, k)!.item.src;
      const was = sources[src];
      if (!was || was.kind === "design") continue;
      const camera = cameraOf(was.camera as EdjCamera | undefined, t.pick);
      if (camera === undefined && t.pick !== "none") throw new Error(`${t.pick} is not a camera here`);
      if (camera && JSON.stringify(camera) !== JSON.stringify(was.camera)) sources[src] = { ...was, camera };
    }
    return Object.keys(sources).some((k) => sources[k] !== s.tl.sources[k]) ? { ...s, tl: { ...s.tl, sources } } : s;
  }, { pick: { type: "text", about: "none, file (what the file says), slog3, flog, flog2, applelog, vlog, clog2, clog3 or a LUT's id" } }),
];
