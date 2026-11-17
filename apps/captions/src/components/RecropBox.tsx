import { useEffect, useRef, useState } from "react";

import type { WindowCrop } from "@contracts/editor";
import { cameraIn, clampCrop, pathAt, type CropBox, type Framing, type TimelineItem } from "@contracts/edit-timeline";

// the reframe maths lives with the timeline edits (contracts/edit-timeline.ts)
export { cameraIn, clampCrop, type CropBox, type Framing };

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

/**
 * Reframe for a shot cut to another shape from a wider picture (an AI Editor moment, TimelineItem.window): the whole
 * picture at the playhead with the frame over it. Drag the frame to hold it there for the shot, click something to
 * follow it (a computer with a graphics card follows it when the next version is made: api/editor/subject.ts), or pick
 * who it follows; each choice is one edit (⌘Z takes it back). Arrows nudge the frame (Shift: further), Esc closes.
 */
export function WindowBox({ item, aspect, src, mediaAt, crop, onCrop, onClose }: {
  item: TimelineItem & { window: NonNullable<TimelineItem["window"]> };
  /** the frame's width over its height (the timeline's) */
  aspect: number;
  /** the shot's picture, played from its media second `mediaAt` */
  src: string;
  mediaAt: number;
  /** the pending edit's choice, else the shot's own */
  crop?: WindowCrop;
  /** undefined = back to the shot as it is cut */
  onCrop: (crop: WindowCrop | undefined) => void;
  onClose: () => void;
}) {
  const win = item.window;
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ px: number; py: number; x0: number; x: number } | null>(null);
  const now = crop ?? win.crop ?? { speaker: 0 };
  const t = mediaAt - win.from;
  // the frame where the choice puts it now: held, the shot's own path (its own choice), or the path it would follow
  const own = !crop || JSON.stringify(crop) === JSON.stringify(win.crop ?? { speaker: 0 });
  const x = drag ? drag.x
    : "x" in now ? now.x
      // a subject clicked: the frame on the click until a computer has followed it
      : "subject" in now ? (own ? pathAt(win.path, t) : Math.min(1, Math.max(0, (now.subject.x - win.w / 2) / (1 - win.w))))
        : pathAt(own ? win.path : (win.follow[now.speaker] ?? win.path), t);
  // a choice: back to the shot's own one clears the edit
  const pick = (c: WindowCrop) => onCrop(JSON.stringify(c) === JSON.stringify(win.crop ?? { speaker: 0 }) ? undefined : c);
  const live = useRef({ x, pick, onClose });
  live.current = { x, pick, onClose };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.matches?.("input, textarea, select, [contenteditable=true]")) return;
      const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (e.key === "Escape") live.current.onClose();
      else if (step) live.current.pick({ x: Math.round(Math.min(1, Math.max(0, live.current.x + step * (e.shiftKey ? 0.1 : 0.01))) * 1e4) / 1e4 });
      else return;
      e.preventDefault();
      e.stopImmediatePropagation(); // not the player's or the timeline's keys
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  const speakers = Object.keys(win.follow).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  const chip = (on: boolean) => `rounded px-1.5 py-0.5 ${on ? "bg-violet-600 text-white" : "text-zinc-300 hover:bg-zinc-800"}`;
  const pct = (v: number) => `${v * 100}%`;
  return (
    <div className="space-y-1.5">
      <div ref={box} title="Drag to hold the frame, click something to follow it" className="relative mx-auto touch-none cursor-ew-resize overflow-hidden rounded bg-black"
        style={{ width: "min(100%, 520px)", aspectRatio: String(aspect / win.w) }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag({ px: e.clientX, py: e.clientY, x0: x, x });
        }}
        onPointerMove={(e) => {
          const r = box.current?.getBoundingClientRect();
          if (!drag || !r || win.w >= 1) return;
          setDrag({ ...drag, x: Math.min(1, Math.max(0, drag.x0 + (e.clientX - drag.px) / (r.width * (1 - win.w)))) });
        }}
        onPointerUp={(e) => {
          const r = box.current?.getBoundingClientRect();
          if (drag && Math.abs(drag.x - drag.x0) > 1e-4) pick({ x: Math.round(drag.x * 1e4) / 1e4 });
          // a click that didn't drag: follow what is under it
          else if (drag && r && Math.hypot(e.clientX - drag.px, e.clientY - drag.py) < 4) {
            const at = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4;
            pick({ subject: { t: Math.round(mediaAt * 1000) / 1000, x: at((e.clientX - r.left) / r.width), y: at((e.clientY - r.top) / r.height) } });
          }
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}>
        <CameraView src={src} time={mediaAt} style={{ inset: 0, width: "100%", height: "100%" }} />
        {/* the frame: what's cut off stays faint around it */}
        <div className="pointer-events-none absolute inset-y-0 shadow-[0_0_0_200vmax_rgba(0,0,0,0.6)] outline outline-2 outline-white"
          style={{ left: pct(x * (1 - win.w)), width: pct(win.w) }} />
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[11px]">
        <span className="text-zinc-500">Follow</span>
        <button type="button" onClick={() => pick({ speaker: 0 })} className={chip("speaker" in now && !now.speaker)}>{speakers.length ? "Who talks" : "Subject"}</button>
        {speakers.map((n) => (
          <button key={n} type="button" onClick={() => pick({ speaker: n })} className={chip("speaker" in now && now.speaker === n)}>Speaker {n}</button>
        ))}
        {"x" in now && <span className="rounded bg-violet-600 px-1.5 py-0.5 text-white">Held</span>}
        {"subject" in now && <span className="rounded bg-violet-600 px-1.5 py-0.5 text-white">Picked</span>}
        <button type="button" onClick={onClose} className="ml-auto rounded px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800">Done</button>
      </div>
    </div>
  );
}
