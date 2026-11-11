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
  /** Inside a zoom the view drifts with the pointer instead of holding still. */
  follow: boolean;
  /** Pointer size, 1 = as on the Mac. */
  pointer: number;
  /** Seconds of pointer path averaged: 0 = raw, 0.3 = very smooth. */
  smooth: number;
  /** The pointer fades out after 2 s without moving. */
  hideIdle: boolean;
  /** A ring where you click. */
  clickRings: boolean;
  /** The pointer is not drawn at all (the rings still are, when on). */
  pointerHidden?: boolean;
  /** A BACKGROUNDS id, "color" (one colour: `color`) or "custom" (a gradient of your two colours: `stops`). */
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
   * - "frame": the window itself is zoomed, corners and all, past the padding to the frame's edges.
   * Only where the whole recording is shown at rest: a frame that is filled (`fill`) has no window to grow.
   */
  zoomFit?: "inside" | "space" | "frame";
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
};

export function defaultCamera(): CameraLook {
  return { layout: "bubble", size: 0.24, corner: "br", shape: "circle", mirror: false };
}

/** A decoded camera frame for drawFrame. */
export type CameraImage = { image: CanvasImageSource; width: number; height: number };

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

const RAMP = 0.7; // seconds into and out of a zoom
const IDLE = 2; // seconds still before the pointer fades

export const DEFAULT_ZOOM = 2;

const CLICKS_SHARE = 5; // presses and releases closer than this (s) share a zoom
const BEFORE_CLICK = 0.6; // a zoom starts this long before its first press: it is all the way in as the press lands
const AFTER_CLICK = 2.5; // and stays this long after its last press or release, to show what that did
const PAUSE = 2; // a pointer still for this long has stopped working

const inPicture = (p: [number, number, number]) => p[1] >= 0 && p[1] <= 1 && p[2] >= 0 && p[2] <= 1;

/**
 * The zooms a new recording opens with.
 * - Where you clicked: presses and releases less than 5 s apart share one zoom, from just before the first to 2.5 s
 *   after the last, aimed at the middle of the presses (with "follow the pointer" on, the view then moves with the
 *   pointer inside it). A drag holds its zoom from press to release. The times are measured on a recording people
 *   were happy with: 236 clicks laid out as five zooms, each starting 0.3 s before its first press and ending 2.5 s
 *   after its last release; presses 4.6 s after a release shared a zoom, 5.7 s after one did not. Ours starts 0.6 s
 *   before, so that its 0.7 s of zooming in is over when the press lands.
 * - With no click in the picture: where the pointer was at work. A stretch counts when the pointer keeps moving
 *   inside the picture for 2.5 s or more, never still for 2 s, and covers some ground; a pointer left lying, or
 *   outside the recorded window, makes no zoom.
 * A click in the last half second is the press that stopped the recording, not something to look at.
 */
export function autoZooms(events: Pick<ScreenEvents, "clicks" | "moves" | "releases">, duration: number, scale = DEFAULT_ZOOM): Zoom[] {
  const last = duration > 0 ? duration : Infinity;
  type Span = { from: number; to: number; x: number; y: number; n: number };
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
        s = { from: c[0], to: c[0], x: 0, y: 0, n: 0 };
        spans.push(s);
      }
      s.to = c[0];
      if (press) {
        s.x += c[1];
        s.y += c[2];
        s.n++;
      }
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
        open = { from: m[0], to: m[0], x: 0, y: 0, n: 0 };
        spans.push(open);
      }
      open.to = m[0];
      open.x += m[1];
      open.y += m[2];
      open.n++;
      prev = m;
    }
    close();
  }
  const zooms: Zoom[] = [];
  for (const s of spans) {
    const start = Math.max(0, s.from - before);
    const end = Math.min(last, Math.max(s.to + after, start + 2.5));
    const x = s.x / s.n;
    const y = s.y / s.n;
    const prevZoom = zooms.at(-1);
    // two that would stand closer than a zoom-out and a zoom-in take become one
    if (prevZoom && start < prevZoom.end + 2 * RAMP) {
      prevZoom.end = Math.max(prevZoom.end, end);
      prevZoom.x = (prevZoom.x + x) / 2;
      prevZoom.y = (prevZoom.y + y) / 2;
    } else if (end - start >= MIN_ZOOM) zooms.push({ start, end, x, y, scale });
  }
  const ms = (v: number) => Math.round(v * 1000) / 1000;
  return zooms.map((z) => ({ ...z, start: ms(z.start), end: ms(z.end), x: ms(z.x), y: ms(z.y) }));
}

export function defaultLook(events: ScreenEvents, duration: number): ScreenLook {
  return {
    zooms: autoZooms(events, duration),
    follow: true,
    pointer: 1.6,
    smooth: 0.15,
    hideIdle: true,
    clickRings: true,
    background: "violet",
    padding: 0.06,
    radius: 0.018,
    shadow: true,
    shape: "source",
    fill: false,
    zoomFit: "space",
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
  look.smooth = num(saved.smooth, 0, 0.4, base.smooth);
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

/** The pointer averaged over `window` seconds around t (the same at any frame rate). */
export function smoothPointer(path: [number, number, number][], t: number, window: number) {
  if (window <= 0.01) return pointerAt(path, t);
  let x = 0;
  let y = 0;
  let n = 0;
  for (let i = 0; i < 9; i++) {
    const p = pointerAt(path, t - window / 2 + (window * i) / 8);
    if (!p) continue;
    x += p.x;
    y += p.y;
    n++;
  }
  return n ? { x: x / n, y: y / n } : null;
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

const ease = (k: number) => {
  const c = Math.min(1, Math.max(0, k));
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
};

/** The zoom at t (1 = none) and the point it aims at (0–1 of the display). */
export function cameraAt(look: ScreenLook, path: [number, number, number][], t: number) {
  let scale = 1;
  let x = 0.5;
  let y = 0.5;
  let held = 0;
  for (const z of look.zooms) {
    if (t < z.start || t > z.end) continue;
    const k = ease((t - z.start) / RAMP) * ease((z.end - t) / RAMP);
    if (k <= held) continue;
    held = k;
    scale = 1 + (z.scale - 1) * k;
    let ax = z.x;
    let ay = z.y;
    if (look.follow) {
      // drifts towards the pointer, slowly (averaged over 1.5 s), never all the way
      const p = smoothPointer(path, t, 1.5);
      if (p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
        ax = z.x + (p.x - z.x) * 0.7;
        ay = z.y + (p.y - z.y) * 0.7;
      }
    }
    x = 0.5 + (ax - 0.5) * k;
    y = 0.5 + (ay - 0.5) * k;
  }
  return { scale, x, y };
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

/** Side by side: the screen on the left (62% of the width less half the gap), the camera on the right (38%), full height. */
export function sideRects(outW: number, outH: number, pad: number): { screen: Rect; camera: Rect } {
  const gap = Math.max(pad, Math.min(outW, outH) * 0.012);
  const x = pad;
  const w = outW - 2 * pad;
  return {
    screen: { x, y: pad, w: w * 0.62 - gap / 2, h: outH - 2 * pad },
    camera: { x: x + w * 0.62 + gap / 2, y: pad, w: w * 0.38 - gap / 2, h: outH - 2 * pad },
  };
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
 * the screen takes the left part of the frame.
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
) {
  const short = Math.min(outW, outH);
  const pad = look.padding * short;
  const inner: Rect = camera?.layout === "side" ? sideRects(outW, outH, pad).screen : { x: pad, y: pad, w: outW - 2 * pad, h: outH - 2 * pad };
  const srcRatio = srcW / srcH;
  let box = inner;
  if (!look.fill || look.shape === "source") {
    const w = Math.min(inner.w, inner.h * srcRatio);
    const h = w / srcRatio;
    box = { x: inner.x + (inner.w - w) / 2, y: inner.y + (inner.h - h) / 2, w, h };
  }
  // the largest part of the source in the box's shape, then zoomed
  const boxRatio = box.w / box.h;
  const baseW = Math.min(srcW, srcH * boxRatio);
  const baseH = baseW / boxRatio;
  const cam = cameraAt(look, path, t);
  let { x: cx, y: cy } = cam;
  if (look.fill && look.shape !== "source" && cam.scale === 1) {
    const p = smoothPointer(path, t, 1.5); // a cropped frame keeps the pointer in view
    if (p) [cx, cy] = [p.x, p.y];
  }
  const grows = zoomGrows(look) && cam.scale > 1;
  if (!grows) {
    const sw = baseW / cam.scale;
    const sh = baseH / cam.scale;
    const sx = Math.min(srcW - sw, Math.max(0, cx * srcW - sw / 2));
    const sy = Math.min(srcH - sh, Math.max(0, cy * srcH - sh / 2));
    return { box, src: { x: sx, y: sy, w: sw, h: sh } as Rect, window: box, grown: 1 };
  }
  // The window grows with the zoom, as far as `limit` lets it: the padded area ("space") or the whole frame
  // ("frame", not over a camera beside it). The point looked at goes to the limit's middle; a window that does not
  // cover the limit yet stays centred in it, one that does never leaves a gap. What is drawn is the part of the grown
  // window inside the limit.
  const whole = look.zoomFit === "frame" && camera?.layout !== "side";
  const limit: Rect = whole ? { x: 0, y: 0, w: outW, h: outH } : inner;
  const W = box.w * cam.scale;
  const H = box.h * cam.scale;
  const place = (size: number, from: number, room: number, at: number) =>
    size <= room ? from + (room - size) / 2 : Math.min(from, Math.max(from + room - size, from + room / 2 - at * size));
  const grownBox: Rect = { x: place(W, limit.x, limit.w, cx), y: place(H, limit.y, limit.h, cy), w: W, h: H };
  const x0 = Math.max(grownBox.x, limit.x);
  const y0 = Math.max(grownBox.y, limit.y);
  const seen: Rect = { x: x0, y: y0, w: Math.min(grownBox.x + W, limit.x + limit.w) - x0, h: Math.min(grownBox.y + H, limit.y + limit.h) - y0 };
  const src: Rect = { x: ((seen.x - grownBox.x) / W) * srcW, y: ((seen.y - grownBox.y) / H) * srcH, w: (seen.w / W) * srcW, h: (seen.h / H) * srcH };
  // "space": the window is what is seen (its corners stay at the padding). "frame": the window is the grown one,
  // its corners and shadow growing with it and leaving the frame.
  return { box: seen, src, window: whole ? grownBox : seen, grown: whole ? cam.scale : 1 };
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
  const still = { ...look, follow: false, zooms: [{ ...zoom, start: -10, end: 10 }] };
  const { src } = layout(still, [], 0, srcW, srcH, outW, outH);
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

/**
 * The camera in a rect: the centred crop that fills it (aspect fill), clipped to a rounded rect (a radius of half the
 * side makes a circle), optionally mirrored, with a soft shadow and a thin light border.
 */
function drawCamera(
  ctx: CanvasRenderingContext2D,
  camera: CameraImage,
  r: Rect,
  o: { radius: number; mirror: boolean; short: number; shadow: boolean; border: boolean },
) {
  const ratio = r.w / r.h;
  const sw = Math.min(camera.width, camera.height * ratio);
  const sh = sw / ratio;
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
  ctx.drawImage(camera.image, (camera.width - sw) / 2, (camera.height - sh) / 2, sw, sh, r.x, r.y, r.w, r.h);
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
  const pad = look.padding * short;
  const cam = camera ? (look.camera ?? defaultCamera()) : null;
  const [from, to] = backgroundStops(look);
  if (from === to) ctx.fillStyle = from;
  else {
    const grad = ctx.createLinearGradient(0, 0, outW, outH);
    grad.addColorStop(0, from);
    grad.addColorStop(1, to);
    ctx.fillStyle = grad;
  }
  ctx.fillRect(0, 0, outW, outH);

  if (camera && cam?.layout === "only") {
    drawCamera(ctx, camera, { x: 0, y: 0, w: outW, h: outH }, { radius: 0, mirror: cam.mirror, short, shadow: false, border: false });
    return;
  }

  const { box, src, window, grown } = layout(look, path, t, srcW, srcH, outW, outH, cam);
  const radius = look.radius * short * grown;
  const shadow = shadowOf(look);
  if (shadow > 0 && look.padding > 0) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${shadow})`;
    ctx.shadowBlur = short * 0.04;
    ctx.shadowOffsetY = short * 0.012;
    ctx.fillStyle = "#000";
    roundRect(ctx, window, radius);
    ctx.fill();
    ctx.restore();
  }
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

  const p = smoothPointer(path, t, look.smooth);
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
    if (cam.layout === "side") {
      drawCamera(ctx, camera, sideRects(outW, outH, pad).camera, { radius, mirror: cam.mirror, short, shadow: true, border: true });
    } else {
      const r = bubbleRect(cam, outW, outH);
      const round = cam.shape === "circle" ? r.w / 2 : r.w * 0.2;
      drawCamera(ctx, camera, r, { radius: round, mirror: cam.mirror, short, shadow: true, border: true });
    }
  }
}
