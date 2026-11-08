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
  /** The sound tracks in file order ("mic", "system"); the export keeps the first. */
  audio?: string[];
};

/** A zoom: from `start` to `end` (s), `scale`× towards (x, y) (0–1 of the display). */
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
  /** A BACKGROUNDS id. */
  background: string;
  /** Space around the picture, 0–0.15 of the frame's short side. */
  padding: number;
  /** Corner radius, 0–0.06 of the frame's short side. */
  radius: number;
  shadow: boolean;
  shape: FrameShape;
  /** In a frame of another shape: fill it (crop, the view follows the pointer) instead of fitting the whole screen. */
  fill: boolean;
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

export const BACKGROUNDS: { id: string; label: string; stops: string[] }[] = [
  { id: "violet", label: "Violet", stops: ["#7c3aed", "#db2777"] },
  { id: "ocean", label: "Ocean", stops: ["#0ea5e9", "#4f46e5"] },
  { id: "sunset", label: "Sunset", stops: ["#f97316", "#e11d48"] },
  { id: "mint", label: "Mint", stops: ["#10b981", "#0d9488"] },
  { id: "paper", label: "Paper", stops: ["#f5f5f4", "#d6d3d1"] },
  { id: "night", label: "Night", stops: ["#27272a", "#09090b"] },
  { id: "black", label: "Black", stops: ["#000000", "#000000"] },
];

const RAMP = 0.7; // seconds into and out of a zoom
const IDLE = 2; // seconds still before the pointer fades

export const DEFAULT_ZOOM = 2;

/** Zooms where you clicked: clicks under 3 s apart share one, which starts 1 s before the first and ends 1.5 s after
 *  the last (at least 2.5 s long), aimed at their middle. */
export function autoZooms(clicks: ScreenEvents["clicks"], duration: number, scale = DEFAULT_ZOOM): Zoom[] {
  const groups: [number, number, number][][] = [];
  for (const c of [...clicks].sort((a, b) => a[0] - b[0])) {
    if (c[1] < 0 || c[1] > 1 || c[2] < 0 || c[2] > 1) continue; // on another display
    const g = groups.at(-1);
    if (g && c[0] - g.at(-1)![0] < 3) g.push(c);
    else groups.push([c]);
  }
  const zooms: Zoom[] = [];
  for (const g of groups) {
    const start = Math.max(0, g[0][0] - 1);
    const end = Math.min(duration || Infinity, Math.max(g.at(-1)![0] + 1.5, start + 2.5));
    const x = g.reduce((s, c) => s + c[1], 0) / g.length;
    const y = g.reduce((s, c) => s + c[2], 0) / g.length;
    const prev = zooms.at(-1);
    // a zoom that would start before the last one has ramped out joins it
    if (prev && start < prev.end + RAMP) {
      prev.end = end;
      prev.x = (prev.x + x) / 2;
      prev.y = (prev.y + y) / 2;
    } else zooms.push({ start, end, x, y, scale });
  }
  return zooms;
}

export function defaultLook(events: ScreenEvents, duration: number): ScreenLook {
  return {
    zooms: autoZooms(events.clicks, duration),
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
  };
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

type Rect = { x: number; y: number; w: number; h: number };

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
  const sw = baseW / cam.scale;
  const sh = baseH / cam.scale;
  const sx = Math.min(srcW - sw, Math.max(0, cx * srcW - sw / 2));
  const sy = Math.min(srcH - sh, Math.max(0, cy * srcH - sh / 2));
  return { box, src: { x: sx, y: sy, w: sw, h: sh } as Rect };
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
 * `source` is the recording's frame at t (a <video>, or the export's decoded frame). `camera` is the camera's frame at
 * t, or null when the recording has no camera. A look without `camera` gets `defaultCamera()` when a camera exists.
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
) {
  const { width: outW, height: outH } = ctx.canvas;
  const short = Math.min(outW, outH);
  const pad = look.padding * short;
  const cam = camera ? (look.camera ?? defaultCamera()) : null;
  const bg = BACKGROUNDS.find((b) => b.id === look.background) ?? BACKGROUNDS[0];
  const grad = ctx.createLinearGradient(0, 0, outW, outH);
  grad.addColorStop(0, bg.stops[0]);
  grad.addColorStop(1, bg.stops[1]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, outW, outH);

  if (camera && cam?.layout === "only") {
    drawCamera(ctx, camera, { x: 0, y: 0, w: outW, h: outH }, { radius: 0, mirror: cam.mirror, short, shadow: false, border: false });
    return;
  }

  const { box, src } = layout(look, path, t, srcW, srcH, outW, outH, cam);
  const radius = look.radius * short;
  if (look.shadow && look.padding > 0) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = short * 0.04;
    ctx.shadowOffsetY = short * 0.012;
    ctx.fillStyle = "#000";
    roundRect(ctx, box, radius);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  roundRect(ctx, box, radius);
  ctx.clip();
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, src.x, src.y, src.w, src.h, box.x, box.y, box.w, box.h);

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
  if (p && alpha > 0 && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
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
