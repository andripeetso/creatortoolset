import { useEffect, useRef } from "react";

/** The camera's framing of the render: zoom, and the pan and tilt in pixels. */
export type Framing = { zoom: number; pan: number; tilt: number };
/** A reframe box as fractions of the frame: x/y = its top-left, k = its width. */
export type CropBox = { x: number; y: number; k: number };

/**
 * Keeps a reframe box on the camera frame: the zoom stays 1x-3x, so the box may
 * be bigger than the render (out to the whole camera frame, which reaches past
 * the render when `f` is zoomed in) and never shows past the camera frame's edges.
 */
export function clampCrop(f: Framing, b: CropBox, w: number, h: number): CropBox {
  const k = Math.min(f.zoom, Math.max(f.zoom / 3, b.k));
  const [x0, y0] = [0.5 + f.pan / w - f.zoom / 2, 0.5 - f.tilt / h - f.zoom / 2]; // the camera frame's corner, in the render
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { k: r(k), x: r(Math.min(x0 + f.zoom - k, Math.max(x0, b.x))), y: r(Math.min(y0 + f.zoom - k, Math.max(y0, b.y))) };
}

/** Where the camera frame sits in the reframe window (fractions of the window: corner, size). */
export const cameraIn = (f: Framing, b: CropBox, w: number, h: number) => ({
  x: (0.5 + f.pan / w - f.zoom / 2 - b.x) / b.k, y: (0.5 - f.tilt / h - f.zoom / 2 - b.y) / b.k, s: f.zoom / b.k,
});

/**
 * Reframe: the frame stays where it is and the footage moves and zooms inside
 * it, the way a video editor's viewer transform works. The page draws the
 * video through `box` (the part of the render the frame shows); this is the
 * frame over it: what's cut off shows faint outside, and the dashed line is the
 * camera frame's edge (as far as the footage goes; past the render's own edge
 * the page lays the camera frame the Mac sends under it). Drag anywhere to move,
 * scroll to zoom about the pointer, arrows nudge a pixel (Shift: 10), Enter
 * applies, Esc cancels.
 */
export function RecropBox({ box, framing: f, w, h, onChange, onApply, onCancel }: {
  box: CropBox; framing: Framing; w: number; h: number;
  onChange: (b: CropBox) => void; onApply: () => void; onCancel: () => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const hit = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; b: CropBox } | null>(null);
  const live = useRef({ box, onChange, onApply, onCancel });
  useEffect(() => {
    live.current = { box, onChange, onApply, onCancel };
  });
  const set = (b: CropBox) => live.current.onChange(clampCrop(f, b, w, h));
  const setRef = useRef(set);
  useEffect(() => {
    setRef.current = set;
  });

  useEffect(() => {
    const el = hit.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return; // ⌥ / pinch zoom the viewer, as everywhere
      e.preventDefault();
      e.stopPropagation();
      const r = frame.current!.getBoundingClientRect();
      const b = live.current.box;
      const [u, v] = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
      const k = b.k * Math.exp(Math.max(-60, Math.min(60, e.deltaY)) * 0.004);
      // the footage under the pointer stays under it
      setRef.current({ k, x: b.x + u * (b.k - k), y: b.y + v * (b.k - k) });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.matches?.("input, textarea, select, [contenteditable=true]")) return;
      const b = live.current.box;
      const n = (e.shiftKey ? 10 : 1) * b.k; // pixels of the new framing (the panel's X / Y)
      const move = { ArrowLeft: [n / w, 0], ArrowRight: [-n / w, 0], ArrowUp: [0, n / h], ArrowDown: [0, -n / h] }[e.key];
      if (e.key === "Enter") live.current.onApply();
      else if (e.key === "Escape") live.current.onCancel();
      else if (move) setRef.current({ k: b.k, x: b.x + move[0], y: b.y + move[1] });
      else return;
      e.preventDefault();
      e.stopImmediatePropagation(); // not the player's or the timeline's keys
    };
    window.addEventListener("keydown", key, true);
    return () => {
      el.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", key, true);
    };
  }, [w, h]);

  const pct = (v: number) => `${v * 100}%`;
  const cam = cameraIn(f, box, w, h);
  return (
    <div ref={frame} className="absolute inset-0 z-10 touch-none">
      {/* anywhere on the stage moves the footage (the stage clips this) */}
      <div ref={hit} className="absolute -inset-[200vmax] cursor-move"
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { px: e.clientX, py: e.clientY, b: box };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          const r = frame.current?.getBoundingClientRect();
          if (!d || !r) return;
          set({ k: d.b.k, x: d.b.x - ((e.clientX - d.px) / r.width) * d.b.k, y: d.b.y - ((e.clientY - d.py) / r.height) * d.b.k });
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)} />
      {/* the frame: what's cut off stays faint around it */}
      <div className="pointer-events-none absolute inset-0 shadow-[0_0_0_200vmax_rgba(0,0,0,0.72)] outline outline-2 outline-white">
        <div className="grid h-full grid-cols-3 grid-rows-3">
          {Array.from({ length: 9 }, (_, i) => <span key={i} className="border border-white/15" />)}
        </div>
      </div>
      <div className="pointer-events-none absolute border border-dashed border-amber-300/70"
        style={{ left: pct(cam.x), top: pct(cam.y), width: pct(cam.s), height: pct(cam.s) }} />
    </div>
  );
}

/** The cut's full camera view (the camera take at zoom 1) under the video while
 *  reframing, held on the page's frame: the picture past the AI's framing, from any moment. */
export function CameraView({ src, time, style }: { src: string; time: number; style: React.CSSProperties }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.readyState >= 1 && Math.abs(el.currentTime - time) > 0.02) el.currentTime = time;
  }, [time]);
  return (
    <video ref={ref} src={src} muted playsInline preload="auto" onLoadedMetadata={(e) => (e.currentTarget.currentTime = time)}
      className="pointer-events-none absolute max-w-none" style={style} />
  );
}
