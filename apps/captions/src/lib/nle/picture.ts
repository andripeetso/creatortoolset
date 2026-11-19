// Where a clip's picture goes in the frame, and which clips play at a moment: what the editor's player draws
// (components/nle/NlePlayer.tsx). The renderer's own geometry, so the player shows what Save will make (checked against
// the renderer's cases in geometry.fixture.json): the source is scaled to cover the frame on V0, V1, V2 and V5 and to fit
// inside it, whole, on the other picture tracks; then, about the source's centre, `crop` cuts fractions off its sides
// (the rest stays where it was), `zoom` scales it, `flip` mirrors it, `rot` turns it (degrees, counter-clockwise), and
// `pan` / `tilt` move it right / up in frame px. Nothing keeps it inside the frame: what is outside is not seen.

import { endOf, isVideo, trackNo, type NleItem, type NleTimeline } from "./model";

export interface Placement {
  /** source px to frame px, as a canvas takes it: x = a*u + c*v + e, y = b*u + d*v + f */
  m: [number, number, number, number, number, number];
  /** the part of the source that shows: x, y, w, h in source px */
  crop: [number, number, number, number];
  alpha: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** The tracks whose pictures cover the frame (the talent, B-roll, the intro); the others fit inside it whole. */
export const covers = (track: string) => ["V0", "V1", "V2", "V5"].includes(track);

export function placement(it: NleItem, track: string, sw: number, sh: number, W: number, H: number): Placement {
  const s = covers(track) ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const k = s * (it.zoom ?? 1);
  const fx = it.flip === "h" || it.flip === "hv" ? -1 : 1;
  const fy = it.flip === "v" || it.flip === "hv" ? -1 : 1;
  const th = (-(it.rot ?? 0) * Math.PI) / 180;
  const [cos, sin] = [Math.cos(th), Math.sin(th)];
  const a = k * fx * cos;
  const b = k * fx * sin;
  const c = -k * fy * sin;
  const d = k * fy * cos;
  const cx = W / 2 + (it.pan ?? 0);
  const cy = H / 2 - (it.tilt ?? 0);
  const [l, t, r, btm] = (it.crop ?? [0, 0, 0, 0]).map((v) => clamp(Number(v) || 0, 0, 1));
  return {
    m: [a, b, c, d, cx - (a * sw) / 2 - (c * sh) / 2, cy - (b * sw) / 2 - (d * sh) / 2],
    crop: [l * sw, t * sh, Math.max(0, 1 - l - r) * sw, Math.max(0, 1 - t - btm) * sh],
    alpha: clamp(it.opacity ?? 1, 0, 1),
  };
}

export type Playing = { track: string; item: NleItem };

const pictureTracks = (tl: NleTimeline) =>
  Object.entries(tl.tracks).filter(([id, t]) => isVideo(id) && !t.hidden && t.enabled !== false);

/** Bottom to top: V1, a track named SOURCE… (the intro's source) right over it, then V2, V3, … (the renderer draws no V0) */
const layer = ([id, t]: [string, { name?: string }]) => (id !== "V1" && (t.name ?? "").toUpperCase().startsWith("SOURCE") ? 1.5 : trackNo(id));

/** The pictures at frame `f`, the bottom one first: tracks that show, clips that are on. */
export function picturesAt(tl: NleTimeline, f: number): Playing[] {
  return pictureTracks(tl)
    .filter(([id]) => trackNo(id) >= 1)
    .sort((x, y) => layer(x) - layer(y))
    .flatMap(([track, t]) => t.items.filter((i) => i.enabled !== false && i.rec <= f && f < endOf(i)).map((item) => ({ track, item })));
}

/** The pictures that start within `ahead` frames after `f` (to have their files ready). */
export const picturesSoon = (tl: NleTimeline, f: number, ahead: number): Playing[] =>
  pictureTracks(tl).flatMap(([track, t]) => t.items.filter((i) => i.enabled !== false && i.rec > f && i.rec <= f + ahead).map((item) => ({ track, item })));

/** A sound to play: from `at` seconds on the timeline, `offset` seconds into its file, for `dur` seconds of timeline. */
export type SoundPiece = { key: string; src: string; at: number; offset: number; dur: number; speed: number; gain: number; fadeIn?: number; fadeOut?: number };

/** Every clip on the sound tracks that are heard, as pieces. */
export function soundPieces(tl: NleTimeline): SoundPiece[] {
  const fps = tl.timeline.fps;
  return Object.entries(tl.tracks)
    .filter(([id, t]) => !isVideo(id) && !t.mute && t.enabled !== false)
    .flatMap(([, t]) => t.items.filter((i) => i.enabled !== false).map((i) => ({
      key: i._k ?? `${i.src}:${i.rec}`,
      src: i.src,
      at: i.rec / fps,
      offset: i.in / (tl.sources[i.src]?.fps || fps),
      dur: i.len / fps,
      speed: i.speed || 1,
      gain: Math.pow(10, (i.gain_db ?? 0) / 20),
      // seconds of fade from / to silence
      ...(i.fade_in ? { fadeIn: i.fade_in / fps } : {}),
      ...(i.fade_out ? { fadeOut: i.fade_out / fps } : {}),
    })));
}

/** Seconds into its source the clip shows at timeline second `t`. */
export const sourceTime = (tl: NleTimeline, it: NleItem, t: number) => {
  const fps = tl.timeline.fps;
  const sfps = tl.sources[it.src]?.fps || fps;
  return (it.in + (t * fps - it.rec) * (sfps / fps) * (it.speed || 1)) / sfps;
};

/** How much smaller than the timeline the viewer draws its frame: the canvas's size on screen in device px, never more
 *  than the timeline's own (a 2160 px frame shown 270 px wide draws 540 px on a 2× screen, not 2160). */
export const drawScale = (cssW: number, dpr: number, W: number) => (cssW > 0 && W > 0 ? Math.min(1, (cssW * (dpr || 1)) / W) : 1);

/** Further than this off the clock, a playing video is moved; nearer, its speed is bent until it is back. */
export const SEEK_S = 0.6;

/** What a playing video does to keep to the timeline's clock when it is `ahead` seconds ahead of it (behind: < 0):
 *  within 2 frames nothing, then its speed bent by up to a quarter, past SEEK_S a move. WebKit stands a video that has
 *  played still for about 240 ms after each move, so moving it for every small drift made playback stall. */
export function steer(ahead: number, speed: number, fps: number): { rate: number; seek: boolean } {
  if (Math.abs(ahead) > SEEK_S) return { rate: speed, seek: true };
  if (Math.abs(ahead) <= 2 / fps) return { rate: speed, seek: false };
  // in steps of 5 %: a speed set on every frame is a hitch of its own
  return { rate: speed * (1 - Math.round(clamp(ahead, -0.25, 0.25) * 20) / 20), seek: false };
}
