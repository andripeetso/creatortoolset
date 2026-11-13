// A screen recording from the Mac app (apps/mac Recorder.swift) made presentable: zooms where you clicked, a smooth,
// larger pointer drawn over the picture (the system one was left out of the recording), a background, padding,
// rounded corners and a shadow, in any frame shape. One drawFrame for the live preview and for the export, so what
// you see is what you get.

/** The pointer log beside the video: seconds from the first frame, positions 0–1 of the recorded display. */
export type ScreenEvents = {
  v: number;
  width: number;
  height: number;
  moves: [number, number, number][];
  clicks: [number, number, number][];
  /** Where a button came up again (a drag lasts from its press to here). Logged from Mac app 0.14.2 on. */
  releases?: [number, number, number][];
  /** The sound tracks in file order ("mic", "system"); the export keeps the first. */
  audio?: string[];
};

/** A zoom: from `start` to `end` (s), `scale`× towards (x, y) (0–1 of the recorded picture). */
export type Zoom = { start: number; end: number; x: number; y: number; scale: number };

export type FrameShape = "source" | "16:9" | "9:16" | "1:1" | "4:5";

export type ScreenLook = {
  zooms: Zoom[];
  /** Inside a zoom the view moves on to a click that would land outside it, instead of holding still. */
  follow: boolean;
  /** Pointer size, 1 = as on the Mac. */
  pointer: number;
  /** How much the pointer's path is smoothed, as seconds of it averaged: 0 = raw, 0.8 = very smooth. */
  smooth: number;
  /** The pointer fades out after 2 s without moving. */
  hideIdle: boolean;
  /** A ring where you click. */
  clickRings: boolean;
  /** The pointer is not drawn at all (the rings still are, when on). */
  pointerHidden?: boolean;
  /**
   * A BACKGROUNDS id, "color" (one colour: `color`), "custom" (a gradient of your two colours: `stops`) or "none"
   * (nothing behind the window: the export keeps it see-through, where one can be made).
   */
  background: string;
  color?: string;
  stops?: [string, string];
  /** Space around the picture, 0–0.15 of the frame's short side. */
  padding: number;
  /** Corner radius, 0–0.06 of the frame's short side. */
  radius: number;
  /** A shadow under the picture, and how dark (0–1; a look saved before the amount existed has 0.45). */
  shadow: boolean;
  shadowAmount?: number;
  /** The part of the recording that is kept (seconds); the rest is cut off the start and the end. */
  trim?: { start: number; end: number };
  shape: FrameShape;
  /** In a frame of another shape: fill it (crop, the view follows the pointer) instead of fitting the whole screen. */
  fill: boolean;
  /**
   * What a zoom does to the window the recording sits in (a look without it: "inside", as it always was).
   * - "inside": the window stays as it is and the picture is zoomed within it, cropped on every side.
   * - "space": the window grows into the empty space around it, up to the padding, and only then crops. A square
   *   recording in a wide frame keeps its whole width at 1.5× where "inside" would cut a third of it off.
   * - "frame": the window itself is zoomed, corners and all, past the padding, until the picture fills the whole
   *   frame: a zoom is then at least as deep as what covers the frame (`zoomFloor`).
   * Only where the whole recording is shown at rest: a frame that is filled (`fill`) has no window to grow.
   */
  zoomFit?: "inside" | "space" | "frame";
  /** The voice is heard, in the editor and in the video it makes. A look without it: yes. */
  voice?: boolean;
  /** The sound the Mac (or the device) played while it recorded is heard. A look without it: yes, when it was recorded. */
  sound?: boolean;
  /**
   * The camera beside the screen, when the recording has one. A look without `camera` gets `defaultCamera()` when a
   * camera exists, so old looks show the camera as a bubble.
   */
  camera?: CameraLook;
};

/** The camera: a bubble over the picture, the camera alone, side by side with the screen, or hidden. */
export type CameraLook = {
  layout: "bubble" | "only" | "side" | "hidden";
  /** Bubble diameter as a fraction of the output's short side. */
  size: number;
  corner: "br" | "bl" | "tr" | "tl";
  shape: "circle" | "rounded";
  /** Flip the camera horizontally. */
  mirror: boolean;
  /** Beside the screen: the camera's share of the width the two take up, 0.2–0.6. Without it: 0.38. */
  split?: number;
  /** How close the camera's picture is cut, 1–3. Without it: 1 (the most of it that fills its place). */
  zoom?: number;
  /** Where in the camera's picture the cut is centred, 0–1, as seen (a mirrored camera's left is its left). Without it: the middle. */
  x?: number;
  y?: number;
  /** Beside the screen: the space between the two, as a part of the frame's short side (0–0.1). Without it: the padding, at least 1.2%. */
  gap?: number;
  /** Beside the screen: the camera on the left. */
  left?: boolean;
  /** The cut follows the face (the Mac app's camera-faces.json, `faceFollower`) instead of `x` and `y`. */
  follow?: boolean;
};

/** Where the face is in the camera file (the Mac app's camera-faces.json): [t, x, y, h] each, 0–1 of the picture as filmed. */
export type FaceTrack = { v: 1; samples: [number, number, number, number][] };

/** Where a face-following cut looks at t, 0–1 of the camera's picture as filmed. */
export type FaceAim = (t: number) => { x: number; y: number };

/**
 * Where the camera's cut looks to follow the face, by time, or null with no face found. It stays still while the face
 * moves a little: only a face that leaves a box around where it looks (6% of the picture each way) moves it, and then
 * all the way to the face. Those steps are smoothed over about two seconds (a Gaussian, σ 0.6 s), worked out for the
 * whole recording at once, so a move starts before the face gets there, eases in and out, and never overshoots or
 * lags. The face sits a little above the middle (headroom).
 */
export function faceFollower(track: FaceTrack | null | undefined): FaceAim | null {
  const s = (track?.samples ?? []).filter((p) => Array.isArray(p) && p.length >= 4 && p.every(Number.isFinite));
  if (!s.length) return null;
  const STEP = 0.1;
  const DEAD = 0.06;
  const SIGMA = 6; // steps
  const n = Math.ceil(s[s.length - 1][0] / STEP) + 1;
  const held: [number, number][] = [];
  let j = 0;
  let aim: [number, number] = [s[0][1], s[0][2] + s[0][3] * 0.15];
  for (let i = 0; i < n; i++) {
    while (j + 1 < s.length && s[j + 1][0] <= i * STEP) j++;
    const [, x, y, h] = s[j];
    const face: [number, number] = [x, y + h * 0.15];
    if (Math.abs(face[0] - aim[0]) > DEAD || Math.abs(face[1] - aim[1]) > DEAD) aim = face;
    held.push(aim);
  }
  const reach = SIGMA * 3;
  const w = Array.from({ length: 2 * reach + 1 }, (_, k) => Math.exp(-((k - reach) ** 2) / (2 * SIGMA * SIGMA)));
  const total = w.reduce((a, b) => a + b, 0);
  const smooth = held.map((_, i) => {
    let x = 0;
    let y = 0;
    for (let k = -reach; k <= reach; k++) {
      const [hx, hy] = held[Math.min(n - 1, Math.max(0, i + k))];
      x += hx * w[k + reach];
      y += hy * w[k + reach];
    }
    return [x / total, y / total] as const;
  });
  return (t) => {
    const at = Math.min(n - 1, Math.max(0, t / STEP));
    const i = Math.floor(at);
    const a = smooth[i];
    const b = smooth[Math.min(n - 1, i + 1)];
    const f = at - i;
    return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f };
  };
}

export function defaultCamera(): CameraLook {
  return { layout: "bubble", size: 0.24, corner: "br", shape: "circle", mirror: false };
}

/** A decoded camera frame for drawFrame. */
export type CameraImage = {
  image: CanvasImageSource;
  width: number;
  height: number;
  /** Where the face is followed to at this frame (FaceAim), as filmed: used where the look's camera has `follow`. */
  aim?: { x: number; y: number };
};

export const BACKGROUNDS: { id: string; label: string; stops: [string, string] }[] = [
  { id: "violet", label: "Violet", stops: ["#7c3aed", "#db2777"] },
  { id: "ocean", label: "Ocean", stops: ["#0ea5e9", "#4f46e5"] },
  { id: "sunset", label: "Sunset", stops: ["#f97316", "#e11d48"] },
  { id: "mint", label: "Mint", stops: ["#10b981", "#0d9488"] },
  { id: "rose", label: "Rose", stops: ["#fda4af", "#be185d"] },
  { id: "amber", label: "Amber", stops: ["#fcd34d", "#ea580c"] },
  { id: "sky", label: "Sky", stops: ["#bae6fd", "#2563eb"] },
  { id: "plum", label: "Plum", stops: ["#6d28d9", "#1e1b4b"] },
  { id: "slate", label: "Slate", stops: ["#64748b", "#1e293b"] },
  { id: "paper", label: "Paper", stops: ["#f5f5f4", "#d6d3d1"] },
  { id: "night", label: "Night", stops: ["#27272a", "#09090b"] },
  { id: "black", label: "Black", stops: ["#000000", "#000000"] },
];

const HEX = /^#[0-9a-f]{6}$/i;

/** The two colours the background runs between (the same twice for one colour). */
export function backgroundStops(look: Pick<ScreenLook, "background" | "color" | "stops">): [string, string] {
  if (look.background === "color") {
    const c = look.color && HEX.test(look.color) ? look.color : "#18181b";
    return [c, c];
  }
  if (look.background === "custom" && look.stops?.every((c) => HEX.test(c))) return look.stops;
  return (BACKGROUNDS.find((b) => b.id === look.background) ?? BACKGROUNDS[0]).stops;
}

/** The look where no see-through video can be made: "none" becomes the first gradient. Any other look as it is. */
export function opaqueLook(look: ScreenLook): ScreenLook {
  return look.background === "none" ? { ...look, background: BACKGROUNDS[0].id } : look;
}

/**
 * The picture a see-through export hands to the Mac app: every frame twice in one H.264 picture (which has no
 * transparency of its own), its colours over black and its matte (white where the frame is opaque, black where it is
 * clear). A wide frame has the two one above the other, a tall one side by side, so the picture stays inside what
 * H.264 takes. The packed picture's shape does not say which (2160×1920 is a tall frame side by side, or a very wide
 * one stacked), so the file's name does: `<name>.stacked.ctalpha.mp4` or `<name>.beside.ctalpha.mp4`. The app
 * (apps/mac AlphaVideo.swift) joins the halves again.
 */
export function alphaPacking(width: number, height: number): { layout: "stacked" | "beside"; width: number; height: number } {
  return width >= height ? { layout: "stacked", width, height: height * 2 } : { layout: "beside", width: width * 2, height };
}

/** The name the packed picture is saved under: the app knows it by its ending and reads how it is packed before it. */
export function alphaFileName(name: string, width: number, height: number): string {
  return `${name}.${alphaPacking(width, height).layout}.ctalpha.mp4`;
}

/** How dark the shadow is, 0–1 (0 = none). */
export function shadowOf(look: Pick<ScreenLook, "shadow" | "shadowAmount">): number {
  return look.shadow ? Math.min(1, Math.max(0, look.shadowAmount ?? 0.45)) : 0;
}

/** Zooms shorter than this are not made or kept. */
export const MIN_ZOOM = 0.6;

/** The kept part of a recording `duration` long: the look's trim inside it, or all of it. At least 0.2 s is kept. */
export function trimOf(look: Pick<ScreenLook, "trim">, duration: number): { start: number; end: number } {
  const start = Math.min(Math.max(0, look.trim?.start ?? 0), Math.max(0, duration - 0.2));
  const end = Math.min(duration, Math.max(start + 0.2, look.trim?.end ?? duration));
  return { start, end };
}

const RAMP = 1; // seconds a move of the view takes: into a zoom, out of it, from one spot to the next inside it
const IDLE = 2; // seconds still before the pointer fades
const NONE: ScreenEvents["clicks"] = [];

export const DEFAULT_ZOOM = 2;

const CLICKS_SHARE = 5; // presses and releases closer than this (s) share a zoom
const BEFORE_CLICK = 0.6; // a zoom starts this long before its first press: it is nine tenths in as the press lands
const AFTER_CLICK = 2.5; // and stays this long after its last press or release, to show what that did
const PAUSE = 2; // a pointer still for this long has stopped working

const inPicture = (p: [number, number, number]) => p[1] >= 0 && p[1] <= 1 && p[2] >= 0 && p[2] <= 1;

/**
 * The zooms a new recording opens with.
 * - Where you clicked: presses and releases less than 5 s apart share one zoom, from just before the first to 2.5 s
 *   after the last, aimed at the middle of the presses (with "follow the clicks" on, the view then moves on to a
 *   press that would land outside it: `viewStops`). A drag holds its zoom from press to release. The times are
 *   measured on a recording people were happy with: 236 clicks laid out as five zooms, each starting 0.3 s before its
 *   first press and ending 2.5 s after its last release; presses 4.6 s after a release shared a zoom, 5.7 s after
 *   one did not. Ours starts 0.6 s before, so that it is nearly all the way in when the press lands.
 * - With no click in the picture: where the pointer was at work. A stretch counts when the pointer keeps moving
 *   inside the picture for 2.5 s or more, never still for 2 s, and covers some ground; a pointer left lying, or
 *   outside the recorded window, makes no zoom.
 * A click in the last half second is the press that stopped the recording, not something to look at.
 */
export function autoZooms(events: Pick<ScreenEvents, "clicks" | "moves" | "releases">, duration: number, scale = DEFAULT_ZOOM): Zoom[] {
  const last = duration > 0 ? duration : Infinity;
  // a stretch of time and the box around the points in it
  type Span = { from: number; to: number; x0: number; x1: number; y0: number; y1: number };
  const span = (c: [number, number, number]): Span => ({ from: c[0], to: c[0], x0: c[1], x1: c[1], y0: c[2], y1: c[2] });
  const widen = (s: Span, x: number, y: number) => {
    s.x0 = Math.min(s.x0, x);
    s.x1 = Math.max(s.x1, x);
    s.y0 = Math.min(s.y0, y);
    s.y1 = Math.max(s.y1, y);
  };
  const spans: Span[] = [];
  const counts = (c: [number, number, number]) => inPicture(c) && last - c[0] >= 0.5;
  const presses = events.clicks.filter(counts);
  let before = BEFORE_CLICK;
  let after = AFTER_CLICK;
  if (presses.length) {
    const marks = [
      ...presses.map((c) => ({ c, press: true })),
      ...(events.releases ?? []).filter(counts).map((c) => ({ c, press: false })),
    ].sort((a, b) => a.c[0] - b.c[0]);
    for (const { c, press } of marks) {
      let s = spans.at(-1);
      if (!s || c[0] - s.to >= CLICKS_SHARE) {
        if (!press) continue; // a release far from any press starts nothing
        s = span(c);
        spans.push(s);
      }
      s.to = c[0];
      if (press) widen(s, c[1], c[2]);
    }
  } else {
    before = 0.5;
    after = 1;
    let open: Span | undefined;
    let ground = 0;
    let prev: [number, number, number] | null = null;
    const close = () => {
      if (open && (open.to - open.from < 2.5 || ground < 0.15)) spans.pop();
      open = undefined;
      ground = 0;
    };
    for (const m of [...events.moves].sort((a, b) => a[0] - b[0])) {
      if (!inPicture(m) || (prev && m[0] - prev[0] >= PAUSE)) close();
      if (!inPicture(m)) {
        prev = null;
        continue;
      }
      if (open && prev) ground += Math.hypot(m[1] - prev[1], m[2] - prev[2]);
      if (!open) {
        open = span(m);
        spans.push(open);
      }
      open.to = m[0];
      widen(open, m[1], m[2]);
      prev = m;
    }
    close();
  }
  const laid: { start: number; end: number; box: Span }[] = [];
  for (const s of spans) {
    const start = Math.max(0, s.from - before);
    const end = Math.min(last, Math.max(s.to + after, start + 2.5));
    const prev = laid.at(-1);
    // two that would stand closer than a zoom-out and a zoom-in take become one
    if (prev && start < prev.end + 2 * RAMP) {
      prev.end = Math.max(prev.end, end);
      widen(prev.box, s.x0, s.y0);
      widen(prev.box, s.x1, s.y1);
    } else if (end - start >= MIN_ZOOM) laid.push({ start, end, box: s });
  }
  const ms = (v: number) => Math.round(v * 1000) / 1000;
  return laid.map(({ start, end, box }) => ({ start: ms(start), end: ms(end), x: ms((box.x0 + box.x1) / 2), y: ms((box.y0 + box.y1) / 2), scale }));
}

export function defaultLook(events: ScreenEvents, duration: number): ScreenLook {
  return {
    zooms: autoZooms(events, duration),
    follow: true,
    pointer: 1.6,
    smooth: 0.4,
    hideIdle: true,
    clickRings: true,
    background: "violet",
    padding: 0.06,
    radius: 0.018,
    shadow: true,
    shape: "source",
    fill: false,
    zoomFit: "frame",
  };
}

/**
 * A saved look made whole: fields a newer editor added get their defaults, numbers stay inside their ranges, and the
 * zooms are in order, inside the recording and apart. Looks are saved as they are (Review's server, the Mac app), so
 * this is the one reader of an old or hand-edited one.
 */
export function normalizeLook(saved: Partial<ScreenLook> | null | undefined, events: ScreenEvents, duration: number): ScreenLook {
  const base = defaultLook(events, duration);
  if (!saved || typeof saved !== "object") return base;
  const num = (v: unknown, min: number, max: number, or: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : or;
  const look: ScreenLook = { ...base, ...saved };
  look.pointer = num(saved.pointer, 0.8, 3, base.pointer);
  look.smooth = num(saved.smooth, 0, 0.8, base.smooth);
  look.padding = num(saved.padding, 0, 0.15, base.padding);
  look.radius = num(saved.radius, 0, 0.06, base.radius);
  const zooms: Zoom[] = [];
  for (const z of Array.isArray(saved.zooms) ? [...saved.zooms].sort((a, b) => a.start - b.start) : base.zooms) {
    if (![z?.start, z?.end, z?.x, z?.y, z?.scale].every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    const start = Math.max(zooms.at(-1)?.end ?? 0, Math.max(0, z.start));
    const end = Math.min(duration || Infinity, z.end);
    if (end - start < MIN_ZOOM) continue;
    zooms.push({ start, end, x: num(z.x, 0, 1, 0.5), y: num(z.y, 0, 1, 0.5), scale: num(z.scale, 1.2, 4, DEFAULT_ZOOM) });
  }
  look.zooms = zooms;
  // a look saved before a zoom could make its window grow keeps the window as it was
  look.zoomFit = saved.zoomFit === "space" || saved.zoomFit === "frame" ? saved.zoomFit : "inside";
  if (saved.trim) look.trim = trimOf(saved, duration);
  return look;
}

/** Moves and clicks as one time-sorted path. */
export function pointerPath(events: ScreenEvents): [number, number, number][] {
  return [...events.moves, ...events.clicks].sort((a, b) => a[0] - b[0]);
}

/** The last index with time ≤ t, or -1. */
function indexAt(path: [number, number, number][], t: number): number {
  let lo = 0;
  let hi = path.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (path[mid][0] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Where the pointer was at t, between the logged points; null before the first. */
export function pointerAt(path: [number, number, number][], t: number): { x: number; y: number } | null {
  const i = indexAt(path, t);
  if (i < 0) return path.length ? { x: path[0][1], y: path[0][2] } : null;
  const a = path[i];
  const b = path[i + 1];
  if (!b || b[0] - a[0] > 0.5) return { x: a[1], y: a[2] }; // a pause: it sat still, then jumped
  const k = (t - a[0]) / (b[0] - a[0] || 1);
  return { x: a[1] + (b[1] - a[1]) * k, y: a[2] + (b[2] - a[2]) * k };
}

const STEP = 1 / 60; // the smoothed pointer is kept at this spacing (s); between two it runs straight
const PIN = 0.25; // seconds each side of a press over which the smoothed pointer is drawn onto it
const smoothed = new WeakMap<[number, number, number][], Map<string, Float32Array>>();

/**
 * The pointer at t with its path smoothed: about `window` seconds of it weigh in, as much before t as after, so the
 * arrow runs neither behind the hand nor ahead of it. Where a press lands (`presses`) the arrow is on it: a ring is
 * drawn there, and the smoothing alone leaves the arrow beside the ring when the hand was moving just before or
 * after. The same at any frame rate.
 */
export function smoothPointer(path: [number, number, number][], t: number, window: number, presses: ScreenEvents["clicks"] = NONE) {
  if (window <= 0.01 || path.length < 2) return pointerAt(path, t);
  let kept = smoothed.get(path);
  if (!kept) smoothed.set(path, (kept = new Map()));
  const key = `${window}|${presses.length}`;
  let xy = kept.get(key);
  if (!xy) {
    if (kept.size >= 4) kept.clear(); // a slider being dragged asks for one window after another
    xy = smoothPath(path, window, presses);
    kept.set(key, xy);
  }
  const n = xy.length / 2;
  const at = Math.min(n - 1, Math.max(0, (t - (path[0][0] - SETTLE * window)) / STEP));
  const i = Math.min(n - 2, Math.floor(at));
  const k = at - i;
  return { x: xy[2 * i] + (xy[2 * i + 2] - xy[2 * i]) * k, y: xy[2 * i + 1] + (xy[2 * i + 3] - xy[2 * i + 1]) * k };
}

const SETTLE = 1.5; // the smoothed path runs this many windows past each end of the log: the arrow sets off and comes to rest inside it

/** The whole path smoothed, x and y in turn, every STEP from SETTLE windows before its first point to as long after its last. */
function smoothPath(path: [number, number, number][], window: number, presses: ScreenEvents["clicks"]): Float32Array {
  const from = path[0][0] - SETTLE * window;
  const n = Math.max(2, Math.ceil((path[path.length - 1][0] + SETTLE * window - from) / STEP) + 1);
  const xy = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = pointerAt(path, from + i * STEP) ?? { x: 0, y: 0 };
    xy[2 * i] = p.x;
    xy[2 * i + 1] = p.y;
  }
  // Each pass lets a point give way to its neighbour, as a weight on a spring gives way: twice forwards, then twice
  // backwards, which takes the lag of the forward passes out again. 0.144: the four passes together spread a point
  // as far as an even average over `window` seconds would.
  const give = 1 - Math.exp(-STEP / (window * 0.144));
  for (let pass = 0; pass < 2; pass++) for (let i = 2; i < n * 2; i++) xy[i] = xy[i - 2] + (xy[i] - xy[i - 2]) * give;
  for (let pass = 0; pass < 2; pass++) for (let i = n * 2 - 3; i >= 0; i--) xy[i] = xy[i + 2] + (xy[i] - xy[i + 2]) * give;
  // onto each press: what is missing there is added, fading out to nothing PIN before and after. Twice over, since
  // presses close together move each other.
  for (let round = 0; round < 2; round++) {
    for (const [t, x, y] of presses) {
      const at = (t - from) / STEP;
      if (at < 0 || at > n - 1) continue;
      const i = Math.min(n - 2, Math.floor(at));
      const k = at - i;
      const dx = x - (xy[2 * i] + (xy[2 * i + 2] - xy[2 * i]) * k);
      const dy = y - (xy[2 * i + 1] + (xy[2 * i + 3] - xy[2 * i + 1]) * k);
      for (let j = Math.max(0, Math.ceil(at - PIN / STEP)); j <= Math.min(n - 1, Math.floor(at + PIN / STEP)); j++) {
        const u = ((j - at) * STEP) / PIN;
        const near = (1 - u * u) ** 2;
        xy[2 * j] += dx * near;
        xy[2 * j + 1] += dy * near;
      }
    }
  }
  return xy;
}

/** Seconds since the pointer last moved (or clicked). */
function stillFor(path: [number, number, number][], t: number): number {
  let i = indexAt(path, t);
  if (i < 0) return Infinity;
  const [, x, y] = path[i];
  while (i > 0 && Math.abs(path[i - 1][1] - x) < 0.002 && Math.abs(path[i - 1][2] - y) < 0.002) i--;
  // a press is movement too
  return t - path[i][0];
}

/**
 * How far a move of the view has come `s` seconds after it set off, 0–1: the way a weight on a damped spring gives
 * way to a pull. It sets off at once, covers nine tenths of the way in the first 0.6 s and lands softly; the last
 * hundredth and a half, which a spring would take for ever over, is spread over the move so that it is done at RAMP.
 * A move given less time (`span`, a zoom too short for a whole way in and out) runs the same curve faster.
 * The spring is damped enough never to pass its mark (damping above 2·√(stiffness·mass) = 45.2), which `cameraAt`
 * relies on.
 */
const glide = (() => {
  const stiffness = 170;
  const damping = 50;
  const mass = 3;
  const mid = damping / (2 * mass);
  const root = Math.sqrt(mid * mid - stiffness / mass);
  const slow = mid - root;
  const fast = mid + root;
  const pull = (s: number) => 1 - (fast * Math.exp(-slow * s) - slow * Math.exp(-fast * s)) / (fast - slow);
  const whole = pull(RAMP);
  return (s: number, span = RAMP) => (s <= 0 ? 0 : s >= span ? 1 : pull((s * RAMP) / span) / whole);
})();

const LEAD = 0.8; // the view sets off this long before the press it moves for: it is there when the press lands
const SHOWN = 0.1; // but not before the press before it has landed and been seen
const MARGIN = 0.1; // of the view: a press nearer its edge than this is not well inside it

/** A view from the picture's `x`, `y` on (its middle), or the picture at rest. */
type Stop = { t: number; depth: number; x: number; y: number; rest?: true; span?: number };

/**
 * Along one side, all 0–1 of the picture: a view `part` long aimed at `aim` (kept inside the picture) shows `v` well
 * inside it. An edge of the picture itself needs no margin.
 */
function holds(aim: number, part: number, v: number): boolean {
  const from = Math.min(1 - part, Math.max(0, aim - part / 2));
  return v >= from + (from > 0 ? part * MARGIN : 0) && v <= from + part - (from < 1 - part ? part * MARGIN : 0);
}

/** The middle a view `part` long can have without leaving the picture, nearest to `aim`. */
const within = (aim: number, part: number) => Math.min(1 - part / 2, Math.max(part / 2, aim));

const stops = new WeakMap<Zoom[], { key: string; clicks: ScreenEvents["clicks"]; stops: Stop[] }>();

/**
 * Where the view is told to go, and when: into each zoom at its start, back to rest in time to be there at its end
 * and, with `follow`, on to the presses inside the zoom that it would not show.
 * A zoom looks where it is aimed for as long as the presses land well inside that view. For a press that would not,
 * the view moves: to the middle of that press and the ones after it that one view holds together, so a run of
 * presses in one corner is one move, not one each. It sets off LEAD before the press. A zoom whose first press is
 * outside its aim goes straight to that press's view. Nothing follows the pointer between presses: where it wanders
 * is not where the work is.
 * What one view holds is worked out on the frame an export has, so a preview of any size moves at the same presses.
 */
function viewStops(look: ScreenLook, clicks: ScreenEvents["clicks"], g: Geometry): Stop[] {
  const key = [look.follow, look.zoomFit, look.fill, look.shape, look.padding, g.srcW / g.srcH, g.camera?.layout === "side" && [g.camera.split, g.camera.gap, g.camera.left].join("/")].join();
  const had = stops.get(look.zooms);
  if (had && had.key === key && had.clicks === clicks) return had.stops;
  const out = outputSize(look.shape, g.srcW, g.srcH, false);
  const fixed = geometry(look, g.srcW, g.srcH, out.width, out.height, g.camera);
  const list: Stop[] = [];
  for (const z of look.zooms) {
    // a zoom too short for a whole way in and out goes in and out faster, turning back half way, and is at rest
    // again at its end; it has no time to move on to anything inside it
    const short = z.end - z.start < 2 * RAMP;
    const span = short ? (z.end - z.start) / 2 : RAMP;
    const leave = z.end - span;
    const part = reach(fixed, Math.max(z.scale, fixed.cover));
    let aim = { x: z.x, y: z.y };
    list.push({ t: z.start, depth: z.scale, ...aim, span });
    if (look.follow && !short) {
      const presses = clicks.filter((c) => c[0] >= z.start && c[0] <= leave && inPicture(c));
      let before = -Infinity;
      for (let i = 0; i < presses.length; i++) {
        const [t, x, y] = presses[i];
        if (!holds(aim.x, part.w, x) || !holds(aim.y, part.h, y)) {
          let box = { x0: x, x1: x, y0: y, y1: y };
          for (let j = i + 1; j < presses.length; j++) {
            const [, px, py] = presses[j];
            const wider = { x0: Math.min(box.x0, px), x1: Math.max(box.x1, px), y0: Math.min(box.y0, py), y1: Math.max(box.y1, py) };
            const mx = (wider.x0 + wider.x1) / 2;
            const my = (wider.y0 + wider.y1) / 2;
            if (!holds(mx, part.w, wider.x0) || !holds(mx, part.w, wider.x1) || !holds(my, part.h, wider.y0) || !holds(my, part.h, wider.y1)) break;
            box = wider;
          }
          aim = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
          list.push({ t: Math.min(t, Math.max(t - LEAD, before + SHOWN, z.start)), depth: z.scale, ...aim });
        }
        before = t;
      }
    }
    list.push({ t: leave, depth: 1, x: 0.5, y: 0.5, rest: true, span });
  }
  list.sort((a, b) => a.t - b.t);
  stops.set(look.zooms, { key, clicks, stops: list });
  return list;
}

/** The view at one moment: `scale`× looking at (x, y) of the picture, `k` of the way from rest into a zoom (0–1). */
type View = { scale: number; x: number; y: number; k: number };

/**
 * The view at t. Every stop pulls the view its way from its own time on, each along the same curve (`glide`), and
 * what the view is at t is all of those pulls added up: the answer of one spring to being sent from stop to stop. So
 * a move that is cut short by the next one carries its speed over, nothing starts or ends with a jerk, and t can be
 * asked for in any order (dragging the playhead, a loop, an export that starts in the middle).
 * It is always a mix of the stops, never past any of them, so it never looks past the picture's edge. What is mixed
 * is the depth and where the picture's corner then lies, not the depth and the aim: that way the picture grows
 * straight out of one point on its way in, every side at an even pace, where mixing the aim would swing it.
 */
function cameraAt(look: ScreenLook, path: [number, number, number][], t: number, clicks: ScreenEvents["clicks"], g: Geometry): View {
  const list = viewStops(look, clicks, g);
  let depth = 0;
  let x = 0;
  let y = 0;
  let rest = 0;
  let later = 0; // how far the stop after this one has pulled the view from it
  let i = list.length - 1;
  while (i >= 0 && list[i].t > t) i--;
  for (; i >= 0 && later < 1; i--) {
    const stop = list[i];
    const done = glide(t - stop.t, stop.span);
    const share = done - later;
    later = done;
    if (stop.rest) rest += share;
    else if (share > 0) {
      const d = Math.max(stop.depth, g.cover);
      const part = reach(g, d);
      depth += share * d;
      x += share * d * within(stop.x, part.w);
      y += share * d * within(stop.y, part.h);
    }
  }
  rest += 1 - later; // before the first stop the picture is at rest
  if (rest > 0) {
    // at rest the whole picture is shown; a frame that is filled shows a part of it, which goes with the pointer
    const p = g.fills ? smoothPointer(path, t, 1.5) : null;
    const part = reach(g, 1);
    depth += rest;
    x += rest * (p ? within(p.x, part.w) : 0.5);
    y += rest * (p ? within(p.y, part.h) : 0.5);
  }
  return { scale: depth, x: x / depth, y: y / depth, k: 1 - rest };
}

/** Output pixels for a frame shape: 1080 on the short side (2160 for 4K), the source's shape for "source". */
export function outputSize(shape: FrameShape, srcW: number, srcH: number, uhd: boolean): { width: number; height: number } {
  const short = uhd ? 2160 : 1080;
  const ratio: Record<Exclude<FrameShape, "source">, number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5 };
  const r = shape === "source" ? srcW / srcH || 16 / 9 : ratio[shape];
  const even = (v: number) => Math.round(v / 2) * 2;
  return r >= 1 ? { width: even(short * r), height: short } : { width: short, height: even(short / r) };
}

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Side by side: the screen on one side, the camera on the other (right unless `left`) taking `split` of the width (less
 * the gap). With the screen's shape (`srcRatio`) the screen is fitted into its part, the camera gets the same height,
 * and the two are centred together, so they sit a gap apart whatever the window's shape; without it (a frame filled by
 * the screen) both take the full height.
 */
export function sideRects(
  outW: number,
  outH: number,
  pad: number,
  cam: Pick<CameraLook, "split" | "gap" | "left"> = {},
  srcRatio?: number,
): { screen: Rect; camera: Rect } {
  const short = Math.min(outW, outH);
  const gap = cam.gap !== undefined ? Math.min(0.1, Math.max(0, cam.gap)) * short : Math.max(pad, short * 0.012);
  const W = outW - 2 * pad - gap;
  const H = outH - 2 * pad;
  const cw = W * (cam.split ?? 0.38);
  const w = srcRatio ? Math.min(W - cw, H * srcRatio) : W - cw;
  const h = srcRatio ? w / srcRatio : H;
  const x = (outW - w - gap - cw) / 2;
  const y = (outH - h) / 2;
  return cam.left
    ? { camera: { x, y, w: cw, h }, screen: { x: x + cw + gap, y, w, h } }
    : { screen: { x, y, w, h }, camera: { x: x + w + gap, y, w: cw, h } };
}

/** The bubble's square, in its corner with a margin of 4% of the short side. */
export function bubbleRect(cam: CameraLook, outW: number, outH: number): Rect {
  const short = Math.min(outW, outH);
  const d = cam.size * short;
  const m = short * 0.04;
  return {
    x: cam.corner[1] === "r" ? outW - m - d : m,
    y: cam.corner[0] === "b" ? outH - m - d : m,
    w: d,
    h: d,
  };
}

/**
 * Where the picture sits in the output and which part of the source it shows at t. With a camera in the side layout
 * the screen takes the left part of the frame. `clicks` are the presses the view follows inside a zoom.
 */
export function layout(
  look: ScreenLook,
  path: [number, number, number][],
  t: number,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  camera: CameraLook | null = null,
  clicks: ScreenEvents["clicks"] = NONE,
) {
  const g = geometry(look, srcW, srcH, outW, outH, camera);
  return placed(g, cameraAt(look, path, t, clicks, g));
}

/** What a look makes of a frame: where the window rests, how far a zoom may make it grow, how much of the picture is seen. */
type Geometry = {
  srcW: number;
  srcH: number;
  camera: CameraLook | null;
  /** The window at rest. */
  box: Rect;
  /** The part of the frame a zoomed window may take up: the padded area ("space") or the whole frame ("frame"). Null where the window keeps its size. */
  limit: Rect | null;
  /** The window itself is zoomed past the padding ("frame"), not cut off at it. */
  whole: boolean;
  /** "frame": the least depth of a zoom, what makes the window cover the frame. 1 elsewhere. */
  cover: number;
  /** The part of the source shown at rest: all of it, or the largest part in the frame's shape where the frame is filled. */
  baseW: number;
  baseH: number;
  /** The frame is filled with a part of the picture, which goes with the pointer. */
  fills: boolean;
};

function geometry(look: ScreenLook, srcW: number, srcH: number, outW: number, outH: number, camera: CameraLook | null): Geometry {
  const { inner, box } = restBox(look, srcW / srcH, outW, outH, camera);
  const boxRatio = box.w / box.h;
  const baseW = Math.min(srcW, srcH * boxRatio);
  const grows = zoomGrows(look);
  const whole = grows && look.zoomFit === "frame" && camera?.layout !== "side";
  const limit: Rect | null = !grows ? null : whole ? { x: 0, y: 0, w: outW, h: outH } : inner;
  return {
    srcW,
    srcH,
    camera,
    box,
    limit,
    whole,
    cover: whole ? Math.max(outW / box.w, outH / box.h) : 1,
    baseW,
    baseH: baseW / boxRatio,
    fills: look.fill && look.shape !== "source",
  };
}

/** How much of the picture's width and height a zoom `depth` deep shows, 0–1. */
function reach(g: Geometry, depth: number): { w: number; h: number } {
  return g.limit
    ? { w: Math.min(1, g.limit.w / (g.box.w * depth)), h: Math.min(1, g.limit.h / (g.box.h * depth)) }
    : { w: g.baseW / depth / g.srcW, h: g.baseH / depth / g.srcH };
}

/** The window and the part of the source in it for a view. */
function placed(g: Geometry, cam: View) {
  const { box, limit, srcW, srcH } = g;
  if (!limit || cam.scale <= 1) {
    const sw = g.baseW / cam.scale;
    const sh = g.baseH / cam.scale;
    const sx = Math.min(srcW - sw, Math.max(0, cam.x * srcW - sw / 2));
    const sy = Math.min(srcH - sh, Math.max(0, cam.y * srcH - sh / 2));
    return { box, src: { x: sx, y: sy, w: sw, h: sh } as Rect, window: box, grown: 1, corners: 1 };
  }
  // The window grows with the zoom, the point looked at in the middle of `limit`, and every side of it leaves the
  // frame at an even pace. Two things hold it: all the way in it covers the limit with no gap at a side (in the
  // middle where it is too small to), and on the way there no side keeps its strip of background longer than that
  // strip takes to close (`shut`: fast at first, so a view at the picture's edge does not trail a thin line of
  // background along that edge for the rest of the move). What is drawn is the part of the grown window inside the
  // limit.
  const W = box.w * cam.scale;
  const H = box.h * cam.scale;
  const full = 1 + (cam.scale - 1) / cam.k; // the depth this zoom has all the way in
  const place = (size: number, restAt: number, restSize: number, from: number, room: number, at: number) => {
    const to = from + room / 2 - at * size;
    const need = room / restSize; // the depth at which the window covers the limit along this side
    if (full < need) return cam.k < 1 ? to : from + (room - size) / 2;
    const open = need > 1 ? (1 - cam.k) ** ((full - 1) / (need - 1)) : 0; // how much of each strip is left
    return Math.min(from + (restAt - from) * open, Math.max(from + room - size - (from + room - restAt - restSize) * open, to));
  };
  const grownBox: Rect = { x: place(W, box.x, box.w, limit.x, limit.w, cam.x), y: place(H, box.y, box.h, limit.y, limit.h, cam.y), w: W, h: H };
  const x0 = Math.max(grownBox.x, limit.x);
  const y0 = Math.max(grownBox.y, limit.y);
  const seen: Rect = { x: x0, y: y0, w: Math.min(grownBox.x + W, limit.x + limit.w) - x0, h: Math.min(grownBox.y + H, limit.y + limit.h) - y0 };
  const src: Rect = { x: ((seen.x - grownBox.x) / W) * srcW, y: ((seen.y - grownBox.y) / H) * srcH, w: (seen.w / W) * srcW, h: (seen.h / H) * srcH };
  // "space": the window is what is seen (its corners stay at the padding). "frame": the window is the grown one,
  // its shadow growing with it and leaving the frame; its corners grow with it too and square off on the way, gone
  // by the time it covers the frame, so no corner of the background shows in a frame that is filled.
  const squared = g.cover > 1.02 ? Math.min(1, (cam.scale - 1) / (g.cover - 1)) : cam.k;
  return { box: seen, src, window: g.whole ? grownBox : seen, grown: g.whole ? cam.scale : 1, corners: g.whole ? cam.scale * (1 - squared) : 1 };
}

/** The padded part of the frame (beside a camera in the side layout: the screen's part) and the window in it at rest. */
function restBox(look: ScreenLook, srcRatio: number, outW: number, outH: number, camera: CameraLook | null): { inner: Rect; box: Rect } {
  const pad = look.padding * Math.min(outW, outH);
  const filled = look.fill && look.shape !== "source";
  const inner: Rect =
    camera?.layout === "side"
      ? sideRects(outW, outH, pad, camera, filled ? undefined : srcRatio).screen
      : { x: pad, y: pad, w: outW - 2 * pad, h: outH - 2 * pad };
  if (look.fill && look.shape !== "source") return { inner, box: inner };
  const w = Math.min(inner.w, inner.h * srcRatio);
  const h = w / srcRatio;
  return { inner, box: { x: inner.x + (inner.w - w) / 2, y: inner.y + (inner.h - h) / 2, w, h } };
}

/**
 * The least depth a zoom has where zooms fill the whole frame ("frame"): what makes the window cover the frame. 1
 * where zooms do something else. `srcRatio` is the recording's width over its height.
 */
export function zoomFloor(look: ScreenLook, srcRatio: number, camera: CameraLook | null = null): number {
  if (look.zoomFit !== "frame" || !zoomGrows(look) || camera?.layout === "side") return 1;
  const out = outputSize(look.shape, srcRatio * 1000, 1000, false);
  const { box } = restBox(look, srcRatio, out.width, out.height, camera);
  return Math.max(out.width / box.w, out.height / box.h);
}

/** A zoom makes the window grow: the look says so, and the whole recording is shown at rest. */
export function zoomGrows(look: Pick<ScreenLook, "zoomFit" | "fill" | "shape">): boolean {
  return (look.zoomFit === "space" || look.zoomFit === "frame") && (!look.fill || look.shape === "source");
}

/**
 * The part of the recording a zoom shows when it is all the way in and looks at its own aim (0–1 of the picture), in
 * a frame `outW`×`outH`: the box the zoom's aim pad draws.
 */
export function zoomView(look: ScreenLook, zoom: Zoom, srcW: number, srcH: number, outW: number, outH: number): Rect {
  const g = geometry(look, srcW, srcH, outW, outH, null);
  const { src } = placed(g, { scale: Math.max(zoom.scale, g.cover), x: zoom.x, y: zoom.y, k: 1 });
  return { x: src.x / srcW, y: src.y / srcH, w: src.w / srcW, h: src.h / srcH };
}

// the macOS-style arrow, 0–1 of its height (tip at 0,0)
const ARROW: [number, number][] = [
  [0, 0], [0, 0.82], [0.2, 0.63], [0.34, 0.95], [0.47, 0.9], [0.33, 0.58], [0.6, 0.58],
];

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, radius: number) {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, radius);
}

const shadows = new Map<string, { image: HTMLCanvasElement; reach: number; cell: number } | null>();

/**
 * The soft shadow under the window `r`. A blurred shadow the size of the window costs the Mac's web view most of a
 * screen refresh, every frame: a preview with it repainted 26 to 31 times a second during a zoom's move, 50 to 60
 * without. So the shadow is made once, small (a square just large enough for four corners), and laid out from that:
 * the four corners as they are, the sides stretched between them. It looks the same, since a side's shadow is the
 * same all along it. A window's corner radius changes while it grows with a zoom; a new small one is made then.
 * Where no canvas can be made beside this one (tests), it is drawn the slow way.
 */
function drawShadow(ctx: CanvasRenderingContext2D, r: Rect, exact: number, blur: number, drop: number, amount: number) {
  const radius = Math.round(exact); // a shadow blurred this much shows no half pixel of its corner, and fewer are made
  const reach = Math.ceil(blur * 2 + drop); // how far outside the window the shadow goes
  // a corner, and as much straight side again as the shadow reaches: a side cut from there is as dark as a long one
  const cell = reach * 2 + radius;
  // on whole pixels, so that the nine parts meet without a seam
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  const w = Math.round(r.x + r.w) - x;
  const h = Math.round(r.y + r.h) - y;
  const key = `${radius}|${blur.toFixed(1)}|${drop.toFixed(1)}|${amount}`;
  let made = shadows.get(key);
  if (made === undefined) {
    if (shadows.size >= 6) shadows.clear();
    const image = typeof document === "undefined" ? null : document.createElement("canvas");
    const own = image?.getContext("2d");
    if (image && own) {
      image.width = image.height = cell * 2;
      own.shadowColor = `rgba(0,0,0,${amount})`;
      own.shadowBlur = blur;
      own.shadowOffsetY = drop;
      own.fillStyle = "#000";
      own.beginPath();
      own.roundRect(reach, reach, (cell - reach) * 2, (cell - reach) * 2, radius);
      own.fill();
      made = { image, reach, cell };
    } else made = null;
    shadows.set(key, made);
  }
  const inner = cell - reach; // how far a corner part goes into the window
  if (!made || w < inner * 2 || h < inner * 2) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${amount})`;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetY = drop;
    ctx.fillStyle = "#000";
    roundRect(ctx, r, radius);
    ctx.fill();
    ctx.restore();
    return;
  }
  const { image } = made;
  const left = x - reach;
  const top = y - reach;
  const right = x + w + reach - cell;
  const bottom = y + h + reach - cell;
  const midW = w - inner * 2;
  const midH = h - inner * 2;
  ctx.drawImage(image, 0, 0, cell, cell, left, top, cell, cell);
  ctx.drawImage(image, cell, 0, cell, cell, right, top, cell, cell);
  ctx.drawImage(image, 0, cell, cell, cell, left, bottom, cell, cell);
  ctx.drawImage(image, cell, cell, cell, cell, right, bottom, cell, cell);
  if (midW > 0) {
    ctx.drawImage(image, cell - 1, 0, 2, cell, left + cell, top, midW, cell);
    ctx.drawImage(image, cell - 1, cell, 2, cell, left + cell, bottom, midW, cell);
  }
  if (midH > 0) {
    ctx.drawImage(image, 0, cell - 1, cell, 2, left, top + cell, cell, midH);
    ctx.drawImage(image, cell, cell - 1, cell, 2, right, top + cell, cell, midH);
  }
  if (midW > 0 && midH > 0) {
    ctx.fillStyle = "#000";
    ctx.fillRect(left + cell, top + cell, midW, midH);
  }
}

/**
 * The part of a camera picture `camW`×`camH` shown in `r`: the most of it in r's shape, `cam.zoom` closer, centred where
 * `cam.x`/`cam.y` aim and kept inside the picture. x is as seen, so a mirrored camera is cut from the other side.
 */
export function cameraCut(camW: number, camH: number, r: Rect, cam: CameraLook | undefined, mirror: boolean) {
  const ratio = r.w / r.h;
  const zoom = Math.min(3, Math.max(1, cam?.zoom ?? 1));
  const sw = Math.min(camW, camH * ratio) / zoom;
  const sh = sw / ratio;
  const fx = cam?.x ?? 0.5;
  const sx = Math.min(camW - sw, Math.max(0, (mirror ? 1 - fx : fx) * camW - sw / 2));
  const sy = Math.min(camH - sh, Math.max(0, (cam?.y ?? 0.5) * camH - sh / 2));
  return { sx, sy, sw, sh };
}

/**
 * Where the camera is drawn in the output, or null where it is not (hidden). `srcRatio` is the recording's width over
 * its height. The bubble's corner rounding comes with it.
 */
export function cameraPlace(look: ScreenLook, cam: CameraLook, outW: number, outH: number, srcRatio: number): { r: Rect; radius: number } | null {
  const short = Math.min(outW, outH);
  if (cam.layout === "only") return { r: { x: 0, y: 0, w: outW, h: outH }, radius: 0 };
  if (cam.layout === "side") {
    const filled = look.fill && look.shape !== "source";
    return { r: sideRects(outW, outH, look.padding * short, cam, filled ? undefined : srcRatio).camera, radius: look.radius * short };
  }
  if (cam.layout === "bubble") {
    const r = bubbleRect(cam, outW, outH);
    return { r, radius: cam.shape === "circle" ? r.w / 2 : r.w * 0.2 };
  }
  return null;
}

/**
 * The camera in a rect: the centred crop that fills it (aspect fill), clipped to a rounded rect (a radius of half the
 * side makes a circle), optionally mirrored, with a soft shadow and a thin light border.
 */
function drawCamera(
  ctx: CanvasRenderingContext2D,
  camera: CameraImage,
  r: Rect,
  o: { radius: number; mirror: boolean; short: number; shadow: boolean; border: boolean; cam?: CameraLook },
) {
  const { sx, sy, sw, sh } = cameraCut(camera.width, camera.height, r, o.cam, o.mirror);
  if (o.shadow) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = o.short * 0.02;
    ctx.shadowOffsetY = o.short * 0.006;
    ctx.fillStyle = "#000";
    roundRect(ctx, r, o.radius);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  roundRect(ctx, r, o.radius);
  ctx.clip();
  if (o.mirror) {
    ctx.translate(r.x * 2 + r.w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(camera.image, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
  ctx.restore();
  if (o.border) {
    ctx.save();
    roundRect(ctx, r, o.radius);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = Math.max(1, o.short * 0.003);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * One output frame at time t: background, the picture (zoomed), the pointer and click rings, then the camera.
 * With the background "none" nothing is painted behind the window: the caller cleared the canvas (the export) or
 * painted what shows through (the preview's checkerboard).
 * `source` is the recording's frame at t (the preview's bitmap of it, or the export's decoded frame). `camera` is the
 * camera's frame at t, or null when the recording has no camera. A look without `camera` gets `defaultCamera()` when a
 * camera exists. `opts.quality` is how carefully the picture is scaled ("high" unless said: the export and a settled
 * preview). While a preview plays or is being changed it hands over `opts.picture` instead, and the picture comes from
 * there.
 * Layouts: bubble (a circle or rounded square in a corner, drawn over everything, never zoomed), only (the camera
 * fills the frame; the screen is not drawn), side (screen left, camera right), hidden (the camera is not drawn).
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  t: number,
  look: ScreenLook,
  path: [number, number, number][],
  clicks: ScreenEvents["clicks"],
  camera: CameraImage | null = null,
  opts: {
    quality?: ImageSmoothingQuality;
    /** The part `src` of the recording's frame already drawn `w`×`h` at the top left of an image (the preview's graphics-card reader); null = draw `source`. */
    picture?: (src: Rect, w: number, h: number) => CanvasImageSource | null;
  } = {},
) {
  const { width: outW, height: outH } = ctx.canvas;
  const short = Math.min(outW, outH);
  const set = camera ? (look.camera ?? defaultCamera()) : null;
  // following the face: the cut looks where the face is at this frame (x as seen, so mirrored for a mirrored camera)
  const cam = set?.follow && camera?.aim ? { ...set, x: set.mirror ? 1 - camera.aim.x : camera.aim.x, y: camera.aim.y } : set;
  if (look.background !== "none") {
    const [from, to] = backgroundStops(look);
    if (from === to) ctx.fillStyle = from;
    else {
      const grad = ctx.createLinearGradient(0, 0, outW, outH);
      grad.addColorStop(0, from);
      grad.addColorStop(1, to);
      ctx.fillStyle = grad;
    }
    ctx.fillRect(0, 0, outW, outH);
  }

  if (camera && cam?.layout === "only") {
    drawCamera(ctx, camera, { x: 0, y: 0, w: outW, h: outH }, { radius: 0, mirror: cam.mirror, short, shadow: false, border: false, cam });
    return;
  }

  const { box, src, window, corners } = layout(look, path, t, srcW, srcH, outW, outH, cam, clicks);
  const radius = look.radius * short * corners;
  const shadow = shadowOf(look);
  // a window that covers the frame has its shadow outside it
  const covers = window.x <= 0 && window.y <= 0 && window.x + window.w >= outW && window.y + window.h >= outH;
  if (shadow > 0 && look.padding > 0 && !covers) drawShadow(ctx, window, radius, short * 0.04, short * 0.012, shadow);
  ctx.save();
  roundRect(ctx, window, radius);
  ctx.clip();
  ctx.imageSmoothingQuality = opts.quality ?? "high";
  const pw = Math.max(1, Math.round(box.w));
  const ph = Math.max(1, Math.round(box.h));
  const ready = opts.picture?.(src, pw, ph);
  if (ready) ctx.drawImage(ready, 0, 0, pw, ph, box.x, box.y, box.w, box.h);
  else ctx.drawImage(source, src.x, src.y, src.w, src.h, box.x, box.y, box.w, box.h);

  // source pixels → output pixels
  const k = box.w / src.w;
  const toOut = (x: number, y: number) => ({ x: box.x + (x * srcW - src.x) * k, y: box.y + (y * srcH - src.y) * k });

  if (look.clickRings) {
    for (const [ct, x, y] of clicks) {
      const age = t - ct;
      if (age < 0 || age > 0.45) continue;
      const p = toOut(x, y);
      const grow = age / 0.45;
      ctx.beginPath();
      ctx.arc(p.x, p.y, srcH * 0.012 * k * (0.6 + grow * 1.6), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.85 * (1 - grow)})`;
      ctx.lineWidth = Math.max(1.5, srcH * 0.0025 * k);
      ctx.stroke();
    }
  }

  const p = smoothPointer(path, t, look.smooth, clicks);
  let alpha = 1;
  if (look.hideIdle) alpha = 1 - Math.min(1, Math.max(0, (stillFor(path, t) - IDLE) / 0.4));
  if (p && !look.pointerHidden && alpha > 0 && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
    const at = toOut(p.x, p.y);
    // a real pointer is ~1.3% of the display's height; it grows with the zoom like the rest of the screen
    const h = srcH * 0.013 * look.pointer * k * 1.25;
    // a press shrinks it a touch
    const pressed = clicks.some(([ct]) => t - ct >= 0 && t - ct < 0.15);
    const s = h * (pressed ? 0.85 : 1);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ARROW.forEach(([x, y], i) => (i ? ctx.lineTo(at.x + x * s, at.y + y * s) : ctx.moveTo(at.x + x * s, at.y + y * s)));
    ctx.closePath();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = s * 0.12;
    ctx.shadowOffsetY = s * 0.04;
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.lineJoin = "round";
    ctx.lineWidth = s * 0.07;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  if (camera && cam && (cam.layout === "bubble" || cam.layout === "side")) {
    const at = cameraPlace(look, cam, outW, outH, srcW / srcH);
    if (at) drawCamera(ctx, camera, at.r, { radius: at.radius, mirror: cam.mirror, short, shadow: true, border: true, cam });
  }
}
