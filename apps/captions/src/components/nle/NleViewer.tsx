import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent, type ReactNode } from "react";
import { Grid2x2, Music } from "lucide-react";
import type { NleTimeline } from "@/lib/nle/model";
import { peaks, wavePath } from "@/lib/waveform";
import { cn } from "@/lib/utils";
import { NlePlayer, type NleFile } from "./NlePlayer";

// The viewer: the timeline's frame at its own size and shape on a grey pasteboard, edged, so a black picture, a gap or
// the time past the last clip (no picture: the pasteboard shows through) still shows where the frame is. Under it: the clock, the play controls, the timeline's size and
// rate, how large the frame is drawn (Fit, 50 %, 100 %) and the safe-area guides.

type Zoom = "fit" | 0.5 | 1;
const ZOOMS: [Zoom, string][] = [["fit", "Fit"], [0.5, "50%"], [1, "100%"]];
const KEY = "ct-nle-viewer";
const PAD = 16;

const readPrefs = (): { zoom: Zoom; guides: boolean } => {
  try {
    const got = JSON.parse(localStorage.getItem(KEY) ?? "null") as { zoom?: Zoom; guides?: boolean } | null;
    return { zoom: ZOOMS.some(([z]) => z === got?.zoom) ? got!.zoom! : "fit", guides: !!got?.guides };
  } catch {
    return { zoom: "fit", guides: false };
  }
};

export function NleViewer({ tl, time, playing, rate, urlOf, nameOf, onClick, clock, transport, loop, below, over, onDragStart, onDragEnd }: {
  tl: NleTimeline;
  time: number;
  playing: boolean;
  rate: number;
  urlOf: (src: string) => NleFile | null;
  nameOf: (src: string) => string;
  /** a click on the frame (play / pause) */
  onClick: () => void;
  clock: ReactNode;
  transport: ReactNode;
  /** looping playback's part (seconds), for the player to have its start ready */
  loop?: [number, number] | null;
  /** under the picture, above the controls (the source's marks strip) */
  below?: ReactNode;
  /** drawn over the frame (a sound source's card) */
  over?: ReactNode;
  /** the frame can be dragged (a source's marked part onto the timeline) */
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
}) {
  const W = tl.timeline.width || 1080;
  const H = tl.timeline.height || 1920;
  const fps = tl.timeline.fps;
  const [prefs, setPrefs] = useState(readPrefs);
  const keep = (p: Partial<typeof prefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // not kept for next time
    }
  };
  const board = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = board.current;
    if (!el) return;
    const read = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // a zoom other than Fit opens on the middle of the frame
  useLayoutEffect(() => {
    const el = board.current;
    if (!el || prefs.zoom === "fit") return;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
  }, [prefs.zoom]);
  const fit = Math.max(0.01, Math.min((room.w - 2 * PAD) / W, (room.h - 2 * PAD) / H));
  const scale = prefs.zoom === "fit" ? fit : prefs.zoom;
  const seg = (on: boolean) => cn("h-6 rounded-[3px] px-1.5 tabular-nums", on ? "bg-zinc-700 text-zinc-50" : "text-zinc-400 hover:text-zinc-100");

  return (
    <div className="flex min-h-0 flex-1 select-none flex-col">
      {/* the pasteboard scrolls when the frame is drawn larger than it; its bars sit in its own edge, so nothing moves */}
      <div ref={board} className={cn("relative min-h-0 flex-1 bg-[#2a2a2e]", prefs.zoom === "fit" ? "overflow-hidden" : "overflow-scroll")}>
        <div className="flex min-h-full min-w-full items-center justify-center" style={{ padding: PAD, width: prefs.zoom === "fit" ? undefined : W * scale + 2 * PAD, height: prefs.zoom === "fit" ? undefined : H * scale + 2 * PAD }}>
          <div data-frame className="relative shrink-0 shadow-[0_0_0_1px_rgb(255_255_255/0.28),0_4px_24px_rgb(0_0_0/0.45)]"
            style={{ width: W * scale, height: H * scale }} onClick={onClick} draggable={!!onDragStart} onDragStart={onDragStart} onDragEnd={onDragEnd}>
            <NlePlayer tl={tl} time={time} playing={playing} rate={rate} urlOf={urlOf} nameOf={nameOf} loop={loop} className="block size-full" />
            {over}
            {prefs.guides && (
              <div aria-hidden className="pointer-events-none absolute inset-0">
                <div className="absolute inset-[5%] border border-dashed border-white/45" />
                <div className="absolute inset-[2.5%] border border-white/20" />
                <div className="absolute top-1/2 left-1/2 h-6 w-px -translate-x-1/2 -translate-y-1/2 bg-white/50" />
                <div className="absolute top-1/2 left-1/2 h-px w-6 -translate-x-1/2 -translate-y-1/2 bg-white/50" />
              </div>
            )}
          </div>
        </div>
      </div>
      {below}
      <div className="grid h-9 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-t border-black/60 bg-[#202024] px-2 text-[11px] text-zinc-400">
        <div className="min-w-0 truncate">{clock}</div>
        <div className="flex items-center gap-0.5">{transport}</div>
        <div className="flex min-w-0 items-center justify-end gap-1.5">
          <span className="truncate font-mono tabular-nums text-zinc-500" title="The size and frame rate">{W}×{H} · {fps} fps</span>
          <span className="inline-flex shrink-0 rounded border border-zinc-800 p-0.5" role="group" aria-label="Viewer zoom">
            {ZOOMS.map(([z, l]) => (
              <button key={l} type="button" aria-pressed={prefs.zoom === z} onClick={() => keep({ zoom: z })} className={seg(prefs.zoom === z)}
                title={z === "fit" ? `The whole frame (${Math.round(fit * 100)}%)` : `${l} of the timeline's size`}>{l}</button>
            ))}
          </span>
          <button type="button" aria-pressed={prefs.guides} aria-label="Safe-area guides" title="Safe-area guides" onClick={() => keep({ guides: !prefs.guides })}
            className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded", prefs.guides ? "bg-zinc-700 text-zinc-50" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100")}>
            <Grid2x2 className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Under a source's picture: its length as a strip, the marked part lit, the playhead; a press or drag scrubs. */
export function SourceStrip({ time, seconds, from, to, onSeek }: {
  time: number;
  seconds: number;
  /** the marked part, seconds (null: not marked) */
  from: number | null;
  to: number | null;
  onSeek: (t: number) => void;
}) {
  const at = (t: number) => `${(Math.max(0, Math.min(1, t / (seconds || 1))) * 100).toFixed(3)}%`;
  const scrub = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * seconds);
  };
  return (
    <div role="slider" aria-label="Source position" aria-valuemin={0} aria-valuemax={seconds} aria-valuenow={time} tabIndex={-1}
      className="relative h-4 shrink-0 cursor-ew-resize touch-none border-t border-black/60 bg-[#151518]"
      onPointerDown={(e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); scrub(e); }}
      onPointerMove={(e) => e.buttons === 1 && scrub(e)}>
      {(from !== null || to !== null) && (
        <div className="absolute inset-y-0.5 bg-zinc-500/35" style={{ left: at(from ?? 0), right: `calc(100% - ${at(to ?? seconds)})` }} />
      )}
      {from !== null && <div className="absolute inset-y-0 w-px bg-zinc-200" style={{ left: at(from) }} />}
      {to !== null && <div className="absolute inset-y-0 w-px bg-zinc-200" style={{ left: at(to) }} />}
      <div className="absolute inset-y-0 w-px -translate-x-1/2 bg-red-500" style={{ left: at(time) }} />
    </div>
  );
}

/** A sound source in the viewer: its waveform across the frame (a plain sound card while it is read or can't be). */
export function SoundCard({ url, seconds, time }: { url: string | null; seconds: number; time: number }) {
  const [wave, setWave] = useState<Float32Array | null>(null);
  useEffect(() => {
    setWave(null);
    if (!url) return;
    let gone = false;
    peaks(url).then((d) => !gone && setWave(d), () => {});
    return () => void (gone = true);
  }, [url]);
  const path = useMemo(() => wave && wavePath(wave, 0, seconds, wave.reduce((a, b) => Math.max(a, b), 0)), [wave, seconds]);
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-emerald-950">
      {path?.d ? (
        <svg className="absolute inset-x-0 top-1/4 h-1/2 w-full text-emerald-300/80" viewBox={`0 -1 ${path.n} 2`} preserveAspectRatio="none">
          <path d={path.d} fill="currentColor" />
        </svg>
      ) : (
        <Music className="size-1/6 text-emerald-400/70" />
      )}
      <div className="absolute inset-y-0 w-px bg-red-500" style={{ left: `${Math.min(100, (time / (seconds || 1)) * 100)}%` }} />
    </div>
  );
}
