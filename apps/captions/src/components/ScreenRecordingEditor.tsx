import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, Pause, Play, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  BACKGROUNDS,
  DEFAULT_ZOOM,
  autoZooms,
  defaultLook,
  drawFrame,
  outputSize,
  pointerAt,
  pointerPath,
  type FrameShape,
  type ScreenEvents,
  type ScreenLook,
} from "@/lib/screen-recording";
import { renderScreenVideo } from "@/lib/screen-export";
import type { ScreenSource } from "@/lib/screen-source";
import { CameraControls } from "@/components/ScreenCameraControls";

const SHAPES: { id: FrameShape; label: string }[] = [
  { id: "source", label: "Screen" },
  { id: "16:9", label: "16:9" },
  { id: "9:16", label: "9:16" },
  { id: "1:1", label: "1:1" },
  { id: "4:5", label: "4:5" },
];

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** A header button. `run` gets the rendered video (`name` has no extension) and reports its own steps. */
export type EditorAction = {
  label: string;
  title?: string;
  primary?: boolean;
  run: (out: { blob: Blob; name: string }, progress: (step: string, pct: number) => void) => Promise<void>;
};

/**
 * Zoom & pointer for a screen recording: zooms where you clicked (edit, add, remove), a smooth larger pointer,
 * background, padding, corners, frame shape, 4K. The caller decides what to do with the rendered video (the
 * header `actions`): Review adds it as the next version; the Screen Recorder page saves it or uploads it.
 * `embedded` fills its parent (a page) instead of covering the window.
 */
export function ScreenRecordingEditor({
  source,
  meta,
  actions,
  onClose,
  embedded = false,
}: {
  source: ScreenSource;
  meta: { name: string; duration: number; width: number; height: number };
  actions: EditorAction[];
  onClose?: () => void;
  embedded?: boolean;
}) {
  const [events, setEvents] = useState<ScreenEvents | null>(null);
  const [look, setLook] = useState<ScreenLook | null>(null);
  const [error, setError] = useState("");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [uhd, setUhd] = useState(false);
  const [making, setMaking] = useState<{ step: string; pct: number } | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const cam = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const abort = useRef<AbortController | null>(null);
  // the source is read through a ref: its identity can change on every page render, its url cannot
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const { duration, width, height } = meta;
  const base = meta.name.replace(/\.(mp4|mov|m4v|webm)$/i, "");

  useEffect(() => {
    sourceRef.current
      .load()
      .then(({ events, look }) => {
        if (!events) throw new Error("This recording has no pointer log");
        setEvents(events);
        setLook(look ?? defaultLook(events, duration));
      })
      .catch((e: Error) => setError(e.message));
    // the url names the recording; a new source for the same one must not reload and lose edits
  }, [source.url, duration]);

  // every change is kept (the page can close any time)
  const first = useRef(true);
  const unsaved = useRef<ScreenLook | null>(null);
  useEffect(() => {
    if (!look) return;
    if (first.current) return void (first.current = false);
    unsaved.current = look;
    const t = window.setTimeout(() => {
      unsaved.current = null;
      sourceRef.current.saveLook(look);
    }, 700);
    return () => window.clearTimeout(t);
  }, [look]);
  // closing within the debounce still saves the last change
  useEffect(() => () => void (unsaved.current && sourceRef.current.saveLook(unsaved.current)), []);

  const path = useMemo(() => (events ? pointerPath(events) : []), [events]);
  const size = look ? outputSize(look.shape, width, height, false) : { width: 16, height: 9 };

  // the preview: the same drawFrame as the export, every animation frame
  useEffect(() => {
    if (!look || !events) return;
    let raf = 0;
    const tick = () => {
      const v = video.current;
      const c = canvas.current;
      const ctx = c?.getContext("2d", { alpha: false });
      if (v && c && ctx && v.readyState >= 2) {
        const k = cam.current;
        if (k && !v.paused && Math.abs(k.currentTime - v.currentTime) > 0.15) k.currentTime = v.currentTime;
        const camera = k && k.readyState >= 2 ? { image: k, width: k.videoWidth, height: k.videoHeight } : null;
        drawFrame(ctx, v, v.videoWidth, v.videoHeight, v.currentTime, look, path, events.clicks, camera);
        if (!v.paused) setTime(v.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [look, events, path]);

  useEffect(() => () => abort.current?.abort(), []);

  const set = (patch: Partial<ScreenLook>) => setLook((l) => (l ? { ...l, ...patch } : l));
  const zoom = picked !== null ? look?.zooms[picked] : undefined;
  const setZoom = (patch: Partial<NonNullable<typeof zoom>>) =>
    setLook((l) => (l && picked !== null ? { ...l, zooms: l.zooms.map((z, i) => (i === picked ? { ...z, ...patch } : z)) } : l));
  const syncCam = (t: number) => {
    if (cam.current) cam.current.currentTime = t;
  };
  const seek = (t: number) => {
    const at = Math.max(0, Math.min(duration, t));
    if (video.current) video.current.currentTime = at;
    syncCam(at);
    setTime(t);
  };
  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  const addZoom = () => {
    if (!look) return;
    const p = pointerAt(path, time) ?? { x: 0.5, y: 0.5 };
    const z = { start: time, end: Math.min(duration, time + 3), x: p.x, y: p.y, scale: DEFAULT_ZOOM };
    const zooms = [...look.zooms, z].sort((a, b) => a.start - b.start);
    set({ zooms });
    setPicked(zooms.indexOf(z));
  };

  const run = async (a: EditorAction, uhdOut: boolean) => {
    if (!look || !events) return;
    const ctl = new AbortController();
    abort.current = ctl;
    const out = outputSize(look.shape, width, height, uhdOut);
    try {
      setMaking({ step: "Making", pct: 0 });
      const blob = await renderScreenVideo({
        url: sourceRef.current.url,
        cameraUrl: sourceRef.current.cameraUrl ?? undefined,
        events,
        look,
        ...out,
        signal: ctl.signal,
        onProgress: (p) => setMaking({ step: "Making", pct: Math.round(p * 100) }),
      });
      if (ctl.signal.aborted) return;
      await a.run({ blob, name: `${base} (zoomed)` }, (step, pct) => {
        if (!ctl.signal.aborted) setMaking({ step, pct: Math.round(pct) });
      });
    } catch (e) {
      if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMaking(null);
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col bg-zinc-950 text-zinc-100",
        embedded ? "min-h-0 flex-1" : "fixed inset-0 z-50",
      )}
      role={embedded ? undefined : "dialog"}
      aria-label="Zoom and pointer"
    >
      <div className="flex min-h-14 items-center gap-3 border-b border-zinc-800 px-4" data-titlebar>
        <span className="text-sm font-semibold">Zoom & pointer</span>
        <span className="truncate text-xs text-zinc-500">{meta.name}</span>
        <div className="ml-auto flex items-center gap-2">
          {error && <span className="max-w-md truncate text-xs text-red-400" title={error}>{error}</span>}
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            <input type="checkbox" checked={uhd} onChange={(e) => setUhd(e.target.checked)} /> 4K
          </label>
          {making ? (
            <Button size="sm" variant="outline" onClick={() => abort.current?.abort()}>
              <Loader2 className="animate-spin" /> {making.step} {making.pct}% · Stop
            </Button>
          ) : (
            actions.map((a) => (
              <Button
                key={a.label}
                size="sm"
                disabled={!look}
                title={a.title}
                variant={a.primary ? "default" : "outline"}
                onClick={() => void run(a, uhd)}
                className={a.primary ? "bg-violet-600 text-white hover:bg-violet-500" : undefined}
              >
                {a.label}
              </Button>
            ))
          )}
          {onClose && (
            <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close">
              <X />
            </Button>
          )}
        </div>
      </div>

      {!look || !events ? (
        <div className="flex flex-1 items-center justify-center">
          {error ? <p className="text-sm text-red-400">{error}</p> : <Loader2 className="h-6 w-6 animate-spin text-zinc-600" />}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              <canvas
                ref={canvas}
                width={Math.round(size.width / 2)}
                height={Math.round(size.height / 2)}
                onClick={toggle}
                className="max-h-full max-w-full cursor-pointer rounded shadow-2xl"
                style={{ aspectRatio: `${size.width} / ${size.height}` }}
              />
              <video
                ref={video}
                src={source.url}
                crossOrigin="anonymous"
                playsInline
                preload="auto"
                className="pointer-events-none absolute h-px w-px opacity-0"
                onPlay={() => {
                  setPlaying(true);
                  if (cam.current) void cam.current.play().catch(() => {});
                }}
                onPause={() => {
                  setPlaying(false);
                  cam.current?.pause();
                }}
                onSeeked={(e) => {
                  setTime(e.currentTarget.currentTime);
                  syncCam(e.currentTarget.currentTime);
                }}
              />
              {source.cameraUrl && (
                // muted: the screen's own track carries the voice; this one only feeds the camera picture
                <video
                  ref={cam}
                  src={source.cameraUrl}
                  crossOrigin="anonymous"
                  muted
                  playsInline
                  preload="auto"
                  className="pointer-events-none absolute h-px w-px opacity-0"
                />
              )}
            </div>

            <div className="border-t border-zinc-800 px-4 py-3">
              <div className="mb-2 flex items-center gap-3 text-xs text-zinc-400">
                <button onClick={toggle} className="rounded p-1 text-zinc-200 hover:bg-zinc-800" aria-label={playing ? "Pause" : "Play"}>
                  {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </button>
                <span className="tabular-nums">{fmt(time)} / {fmt(duration)}</span>
                <button onClick={addZoom} className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-violet-300 hover:bg-zinc-900">
                  <Plus className="h-3.5 w-3.5" /> Zoom here
                </button>
                <button
                  onClick={() => {
                    set({ zooms: autoZooms(events.clicks, duration) });
                    setPicked(null);
                  }}
                  title="Throw away the zooms and make them again from your clicks"
                  className="flex items-center gap-1 rounded px-2 py-1 hover:bg-zinc-900"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> From clicks
                </button>
              </div>
              {/* the zooms over the recording; a press seeks, a zoom picks it */}
              <div
                className="relative h-12 cursor-pointer rounded bg-zinc-900"
                onPointerDown={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  seek(((e.clientX - r.left) / r.width) * duration);
                }}
              >
                {events.clicks.map(([t], i) => (
                  <span key={i} className="absolute bottom-0 h-2 w-px bg-zinc-600" style={{ left: `${(t / duration) * 100}%` }} />
                ))}
                {look.zooms.map((z, i) => (
                  <button
                    key={i}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setPicked(i);
                      seek(z.start + 0.1);
                    }}
                    className={cn(
                      "absolute top-1.5 h-7 rounded border text-[10px] font-medium",
                      picked === i ? "border-violet-300 bg-violet-500/60 text-white" : "border-violet-500/50 bg-violet-500/25 text-violet-200",
                    )}
                    style={{ left: `${(z.start / duration) * 100}%`, width: `${Math.max(0.4, ((z.end - z.start) / duration) * 100)}%` }}
                  >
                    {z.scale.toFixed(1)}×
                  </button>
                ))}
                <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-zinc-100" style={{ left: `${(time / duration) * 100}%` }} />
              </div>
            </div>
          </div>

          <aside className="w-72 shrink-0 space-y-5 overflow-y-auto border-l border-zinc-800 p-4 text-sm">
            {zoom && (
              <Section title={`Zoom ${fmt(zoom.start)}–${fmt(zoom.end)}`}>
                <Slider label="Depth" value={zoom.scale} min={1.2} max={4} step={0.1} show={(v) => `${v.toFixed(1)}×`} onChange={(scale) => setZoom({ scale })} />
                <Slider label="Starts" value={zoom.start} min={0} max={Math.max(0, zoom.end - 0.5)} step={0.1} show={fmt} onChange={(start) => setZoom({ start })} />
                <Slider label="Ends" value={zoom.end} min={zoom.start + 0.5} max={duration} step={0.1} show={fmt} onChange={(end) => setZoom({ end })} />
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      const p = pointerAt(path, time);
                      if (p) setZoom({ x: p.x, y: p.y });
                    }}
                    className="rounded px-2 py-1 text-xs text-violet-300 hover:bg-zinc-900"
                    title="Aim this zoom where the pointer is now"
                  >
                    Aim at the pointer
                  </button>
                  <button
                    onClick={() => {
                      set({ zooms: look.zooms.filter((_, i) => i !== picked) });
                      setPicked(null);
                    }}
                    className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-red-300 hover:bg-zinc-900"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove
                  </button>
                </div>
              </Section>
            )}

            <Section title="Zooms">
              <Toggle label="Follow the pointer" checked={look.follow} onChange={(follow) => set({ follow })} />
              <Slider
                label="Depth of every zoom"
                value={look.zooms[0]?.scale ?? DEFAULT_ZOOM}
                min={1.2}
                max={4}
                step={0.1}
                show={(v) => `${v.toFixed(1)}×`}
                onChange={(scale) => set({ zooms: look.zooms.map((z) => ({ ...z, scale })) })}
              />
            </Section>

            <Section title="Pointer">
              <Slider label="Size" value={look.pointer} min={0.8} max={3} step={0.1} show={(v) => `${v.toFixed(1)}×`} onChange={(pointer) => set({ pointer })} />
              <Slider label="Smooth" value={look.smooth} min={0} max={0.4} step={0.01} show={(v) => (v ? `${Math.round(v * 100)}` : "off")} onChange={(smooth) => set({ smooth })} />
              <Toggle label="Hide when still" checked={look.hideIdle} onChange={(hideIdle) => set({ hideIdle })} />
              <Toggle label="Ring on clicks" checked={look.clickRings} onChange={(clickRings) => set({ clickRings })} />
            </Section>

            {source.cameraUrl && <CameraControls look={look} onChange={(next) => setLook(next)} />}

            <Section title="Frame">
              <div className="flex flex-wrap gap-1">
                {SHAPES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => set({ shape: s.id })}
                    className={cn("rounded px-2 py-1 text-xs", look.shape === s.id ? "bg-violet-600 text-white" : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800")}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {look.shape !== "source" && (
                <Toggle label="Fill the frame (crop, follow the pointer)" checked={look.fill} onChange={(fill) => set({ fill })} />
              )}
              <Slider label="Padding" value={look.padding} min={0} max={0.15} step={0.005} show={(v) => `${Math.round(v * 100)}`} onChange={(padding) => set({ padding })} />
              <Slider label="Corners" value={look.radius} min={0} max={0.06} step={0.002} show={(v) => `${Math.round(v * 1000)}`} onChange={(radius) => set({ radius })} />
              <Toggle label="Shadow" checked={look.shadow} onChange={(shadow) => set({ shadow })} />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {BACKGROUNDS.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => set({ background: b.id })}
                    title={b.label}
                    aria-label={b.label}
                    className={cn("h-7 w-7 rounded-full border-2", look.background === b.id ? "border-zinc-100" : "border-transparent")}
                    style={{ background: `linear-gradient(135deg, ${b.stops[0]}, ${b.stops[1]})` }}
                  />
                ))}
              </div>
            </Section>
            {events.audio && events.audio.length > 1 && (
              <p className="text-xs text-zinc-500">The video keeps your voice. The Mac's sound is a second track in the original file.</p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

function Slider({ label, value, min, max, step, show, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  show: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex justify-between text-xs text-zinc-400">
        {label} <span className="tabular-nums text-zinc-500">{show(value)}</span>
      </span>
      <input type="range" className="w-full accent-violet-500" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-zinc-300">
      {label}
      <input type="checkbox" className="accent-violet-500" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
