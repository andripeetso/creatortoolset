import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Film, Loader2, Trash2, X } from "lucide-react";
import { sameTake, type ItemEdit, type TimelineItem, type TimelineView } from "@contracts/edit-timeline";
import {
  NEUTRAL, SKIN_LINE, apply, delta, fromHue, fromWheel, full, luma, sameGrade, satMatrix, tables, toWheel,
  type Grade, type RGB,
} from "@contracts/grade";
import { SQUEEZE, TOP, gallery, paint, sampleStill, sampleVideo, type GalleryStill, type Sample, type Still } from "@/lib/grade-look";
import type { ReviewEditRef, ReviewTimelineSlot } from "@/lib/plugin";
import { cn } from "@/lib/utils";

/**
 * Colour in Review, by hand only (nothing grades on its own): primaries on the
 * picked talent shot. Wheels (ball = balance, ring = master), contrast / pivot /
 * saturation, and scopes. A gesture is one undo step; the grade rides on the
 * next comment like any hand edit. Copy it to the shots of the same take.
 *
 * Full quality, where a plug-in gives it (`look`, on an AI edit): paused on the
 * shot, that frame from the camera original (12-bit, superwhites kept) is
 * graded here, exactly, over the proxy; "Full-quality clip" plays the shot from
 * the original. The gallery keeps graded stills (in this browser) to wipe against.
 */
export function GradePanel({ view, item, pending, video, edit: shotOf, look, onLive, onApply, onClose }: {
  view: TimelineView;
  item: TimelineItem;
  /** its unsent grade edit */
  pending?: Grade;
  video: React.RefObject<HTMLVideoElement | null>;
  /** the AI edit behind the video, and the plug-in that sends its full-quality frames and clips */
  edit?: ReviewEditRef | null;
  look?: ReviewTimelineSlot["look"];
  /** the grade to show on the video now (null = what's rendered) */
  onLive: (g: Grade | null) => void;
  onApply: (changes: [TimelineItem, Partial<ItemEdit>][]) => void;
  onClose: () => void;
}) {
  const ref = look ? shotOf : null;
  const [g, setG] = useState<Grade>(full(pending ?? item.grade));
  const [bypass, setBypass] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edit = (x: Grade | undefined, it: TimelineItem = item): Partial<ItemEdit> => ({ grade: !x || sameGrade(x, it.grade) ? undefined : x });

  // another shot, or undo / redo from the page: the wheels follow
  const [seen, setSeen] = useState({ pending, key: item.key });
  if (seen.pending !== pending || seen.key !== item.key) {
    setSeen({ pending, key: item.key });
    setG(full(pending ?? item.grade));
  }
  useEffect(() => onLive(bypass ? NEUTRAL : g), [g, bypass]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onLive(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<Grade>) => {
    const next = { ...g, ...patch };
    setG(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { // one undo step per gesture
      timer.current = null;
      onApply([[item, edit(next)]]);
    }, 350);
  };
  const jump = (next: Grade) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setG(next);
    onApply([[item, edit(next)]]);
  };

  // ---- full quality: the paused frame from the camera original, or the shot as a clip ----
  const fps = view.fps || 25;
  const [pos, setPos] = useState({ paused: true, frame: 0 });
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const on = () => setPos({ paused: el.paused, frame: Math.floor(el.currentTime * fps + 0.01) });
    on();
    const evs = ["pause", "play", "seeked", "playing"] as const;
    evs.forEach((e) => el.addEventListener(e, on));
    return () => evs.forEach((e) => el.removeEventListener(e, on));
  }, [video, fps]);
  const inShot = pos.frame >= item.rec && pos.frame < item.rec + item.len;
  const [hq, setHq] = useState(!!ref);
  // the frames the Mac sent (the last 8: each is 12 MB here) and the last one that failed
  const [frames, setFrames] = useState<Record<string, Still>>({});
  const [failed, setFailed] = useState<{ k: string; error: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const k = `${item.key}@${pos.frame}`;
  const wanted = !!ref && hq && pos.paused && inShot;
  // by value: the page hands a new `edit` object on every refresh, which restarted the load forever
  // (2026-09-30: the Mac sent the same frame five times, the viewer showed none)
  const [proj, draft] = [ref?.project, ref?.draft];
  useEffect(() => {
    if (!proj || !draft || !wanted || frames[k]) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      look!.still({ project: proj, draft }, item.key, pos.frame, ctl.signal).then((s) => setFrames((f) => {
        const next = { ...f, [k]: s };
        for (const old of Object.keys(next).slice(0, -8)) delete next[old];
        return next;
      }), (e: Error) => e.name !== "AbortError" && setFailed({ k, error: e.message }));
    }, 350);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [proj, draft, wanted, k, frames, item.key, pos.frame, retry]);
  const stillNow = wanted ? frames[k] ?? null : null;
  const hqState: "" | "loading" | { error: string } = !wanted || stillNow ? "" : failed?.k === k ? { error: failed.error } : "loading";

  const [clip, setClip] = useState<{ url?: string; error?: string } | null>(null);
  const clipEl = useRef<HTMLVideoElement>(null);
  useEffect(() => () => { if (clip?.url) URL.revokeObjectURL(clip.url); }, [clip?.url]);
  const clipCtl = useRef<AbortController | null>(null);
  const playClip = () => {
    if (!ref) return;
    video.current?.pause();
    setClip({});
    clipCtl.current = new AbortController();
    look!.clip(ref, item.key, Math.max(pos.frame, item.rec), clipCtl.current.signal)
      .then((url) => setClip({ url }), (e: Error) => e.name !== "AbortError" && setClip({ error: e.message }));
  };

  // loading from the Mac, plainly in view and cancellable: the viewer is covered, and play or a seek is undone until
  // it's there (a stray play would break the load)
  const loading: "" | "frame" | "clip" = clip && !clip.url && !clip.error ? "clip" : wanted && hqState === "loading" ? "frame" : "";
  const cancel = () => {
    if (loading === "clip") {
      clipCtl.current?.abort();
      setClip(null);
    } else setHq(false);
  };
  useEffect(() => {
    const el = video.current;
    if (!el || !loading) return;
    const at = (pos.frame + 0.5) / fps;
    const hold = () => el.pause();
    const stay = () => {
      if (Math.abs(el.currentTime - at) > 0.5 / fps) el.currentTime = at;
    };
    // capture: before the panel's own play listener, whose re-render would drop this one mid-event
    el.addEventListener("play", hold, true);
    el.addEventListener("seeking", stay, true);
    return () => {
      el.removeEventListener("play", hold, true);
      el.removeEventListener("seeking", stay, true);
    };
  }, [loading, video, fps]); // eslint-disable-line react-hooks/exhaustive-deps -- the frame it started on

  const shown = bypass ? NEUTRAL : g;

  // ---- the gallery: graded stills to wipe against ----
  const [stills, setStills] = useState<GalleryStill[]>([]);
  const [cmp, setCmp] = useState<GalleryStill | null>(null);
  const [wipe, setWipe] = useState(0.5);
  useEffect(() => {
    if (proj) gallery.all(proj).then(setStills, () => {});
  }, [proj]);
  const grab = () => {
    if (!ref || !stillNow) return;
    const c = document.createElement("canvas");
    c.width = stillNow.w;
    c.height = stillNow.h;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(stillNow.w, stillNow.h);
    paint(img, stillNow, shown);
    ctx.putImageData(img, 0, 0);
    const t = document.createElement("canvas");
    t.width = 90;
    t.height = Math.round((90 * stillNow.h) / stillNow.w);
    t.getContext("2d")!.drawImage(c, 0, 0, t.width, t.height);
    const s: GalleryStill = {
      id: crypto.randomUUID(), project: ref.project, label: `${item.label.split(" · ")[0]} · ${view.name}`,
      still: { w: stillNow.w, h: stillNow.h, codes: stillNow.codes }, grade: shown,
      thumb: t.toDataURL("image/jpeg", 0.8), created: Date.now(),
    };
    gallery.put(s).then(() => setStills((l) => [...l, s]), () => {});
  };

  const take = sameTake(view, item).filter((x) => x.key !== item.key);
  const was = item.grade;
  // what the scopes read: the full-quality clip or still when there is one (both ungraded), else the proxy (graded `was`)
  const stillSample = useMemo(() => (stillNow ? sampleStill(stillNow) : null), [stillNow]);
  const source = clip?.url
    ? { sample: () => sampleVideo(clipEl.current, TOP), show: (c: readonly number[]) => apply(shown, c), label: "full-quality clip" }
    : stillSample
      ? { sample: () => stillSample, show: (c: readonly number[]) => apply(shown, c), label: "full-quality frame" }
      : { sample: () => sampleVideo(video.current), show: delta(was, shown).apply, label: "proxy (8-bit preview)" };
  const btn = "rounded border border-zinc-800 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent";
  const stage = video.current?.parentElement ?? null;

  return (
    <div className="flex min-h-0 flex-1 select-none flex-col gap-3 overflow-y-auto px-3 py-2 text-xs text-zinc-200">
      <div className="flex items-center gap-1">
        <span className="font-medium">Color</span>
        <span className="mr-auto truncate text-zinc-400">{item.label.split(" · ")[0]}</span>
        <button className={cn(btn, bypass && "bg-amber-500/90 text-black hover:bg-amber-400")} onClick={() => setBypass((b) => !b)}
          title="Bypass: the shot with no grade at all">Bypass</button>
        <button className={btn} onClick={() => jump(full(item.grade))} title="Back to the grade this version has">Reset</button>
        <button aria-label="Close colour" className="rounded p-1 text-zinc-400 hover:bg-zinc-800" onClick={onClose}><X className="h-3.5 w-3.5" /></button>
      </div>
      {ref && (
        <div className="flex flex-wrap items-center gap-1">
          <label className="flex items-center gap-1 text-zinc-300" title="Paused on this shot, grade the frame from the camera original (10-bit, superwhites), not the preview">
            <input type="checkbox" checked={hq} onChange={(e) => setHq(e.target.checked)} className="accent-violet-500" /> Full-quality frame
          </label>
          <button className={btn} onClick={clip ? () => setClip(null) : playClip}
            title="Play this shot from the camera original, graded live">
            <Film className="mr-1 inline h-3 w-3" />{clip ? "Close clip" : "Full-quality clip"}
          </button>
          {clip?.error || typeof hqState === "object" ? (
            <span className="text-[11px] text-amber-400">
              {clip?.error ?? (hqState as { error: string }).error}: grading the proxy.{" "}
              <button className="underline hover:text-amber-300"
                onClick={() => (clip?.error ? playClip() : (setFailed(null), setRetry((r) => r + 1)))}>Try again</button>
            </span>
          ) : (
            <span className="text-[11px] text-zinc-500">
              {clip && !clip.url ? "the Mac is rendering the shot…"
                : hqState === "loading" ? "the Mac is sending the frame…"
                : hq && !pos.paused ? "pause to grade the full-quality frame"
                : hq && !inShot ? "the playhead isn't on this shot" : ""}
            </span>
          )}
        </div>
      )}
      <Scopes sample={source.sample} show={source.show} label={source.label} />
      <div className="grid grid-cols-2 gap-x-2 gap-y-3">
        <Wheel name="Lift" v={g.lift} zero={0} ball={0.1} ring={[-0.25, 0.25]} digits={3} onChange={(lift) => set({ lift })} />
        <Wheel name="Gamma" v={g.gamma} zero={0} ball={0.2} ring={[-0.6, 0.6]} digits={3} onChange={(gamma) => set({ gamma })} />
        <Wheel name="Gain" v={g.gain} zero={1} ball={0.2} ring={[0.5, 2]} digits={2} onChange={(gain) => set({ gain })} />
        <Wheel name="Offset" v={g.offset} zero={0} ball={0.1} ring={[-0.15, 0.15]} digits={3} onChange={(offset) => set({ offset })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Slide name="Contrast" v={g.contrast} zero={1} range={[0.5, 2]} onChange={(contrast) => set({ contrast })} />
        <Slide name="Pivot" v={g.pivot} zero={NEUTRAL.pivot} range={[0.2, 0.7]} step={0.005} digits={3} onChange={(pivot) => set({ pivot })} />
        <Slide name="Sat" v={g.sat} zero={1} range={[0, 2]} onChange={(sat) => set({ sat })} />
      </div>
      <div className="flex flex-wrap gap-1">
        <button className={btn} disabled={!take.length} onClick={() => onApply([[item, edit(g)], ...take.map((x): [TimelineItem, Partial<ItemEdit>] => [x, edit(g, x)])])}
          title="The same grade on every shot of this camera take (same light)">Copy to take ({take.length})</button>
      </div>
      {ref && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-zinc-400">Gallery</span>
            <button className={cn(btn, "ml-auto")} disabled={!stillNow} onClick={grab}
              title={stillNow ? "Keep this frame as graded now (in this browser)" : "Pause on the shot with Full-quality frame on first"}>
              <Camera className="mr-1 inline h-3 w-3" />Grab still
            </button>
          </div>
          {stills.length > 0 && (
            <div className="grid grid-cols-4 gap-1.5">
              {stills.map((s) => (
                <div key={s.id} className={cn("group relative overflow-hidden rounded border", cmp?.id === s.id ? "border-violet-400" : "border-zinc-800")}>
                  <button className="block w-full" onClick={() => setCmp((c) => (c?.id === s.id ? null : s))}
                    title={`${s.label}: click to wipe against it on the video`}>
                    <img src={s.thumb} alt={s.label} className="block w-full" />
                  </button>
                  <div className="absolute inset-x-0 bottom-0 flex justify-between bg-black/70 px-0.5 opacity-0 group-hover:opacity-100">
                    <button aria-label="Delete still" className="px-1 text-zinc-400 hover:text-zinc-50"
                      onClick={() => gallery.remove(s.id).then(() => { setStills((l) => l.filter((x) => x.id !== s.id)); if (cmp?.id === s.id) setCmp(null); })}>
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {cmp && !stillNow && <p className="text-[11px] text-amber-400">The wipe shows on the full-quality frame: pause on the shot.</p>}
        </div>
      )}
      <p className="text-[10px] leading-snug text-zinc-500">
        Double-click a wheel, ring or slider to reset it. Your grade goes with your next comment{ref ? "; the next version renders it" : ""}. The AI never grades on its own.
      </p>
      {stage && createPortal(
        <Stage still={clip ? null : stillNow} grade={shown} cmp={cmp} wipe={wipe} setWipe={setWipe}
          clip={clip?.url} clipEl={clipEl} loading={loading} onCancel={cancel}
          note={typeof hqState === "object" ? hqState.error : clip?.error} />,
        stage)}
    </div>
  );
}

// ---- over the video while the Mac works: the whole picture, a big spinner, Cancel ----

function Loading({ what, onCancel }: { what: "frame" | "clip"; onCancel: () => void }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="absolute inset-0 z-20 flex select-none flex-col items-center justify-center gap-3 bg-black/60 px-4 text-center text-white backdrop-blur-sm"
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <Loader2 className="h-12 w-12 animate-spin text-violet-300" />
      <div>
        <p className="text-base font-semibold">{what === "clip" ? "Loading the full-quality clip" : "Loading the full-quality frame"}</p>
        <p className="mt-1 text-xs text-zinc-300">
          from the camera original on your Mac{secs >= 2 ? ` · ${secs} s` : ""}{secs >= 20 ? " (the footage drive is slow to wake)" : ""}
        </p>
      </div>
      <button onClick={onCancel} className="rounded-md border border-white/30 bg-white/10 px-4 py-1.5 text-sm font-medium hover:bg-white/20">
        Cancel
      </button>
      <p className="text-[11px] text-zinc-400">Playing waits until it's here.</p>
    </div>
  );
}

// ---- over the video: the graded full-quality frame (with a wipe), or the clip ----

function Stage({ still, grade, cmp, wipe, setWipe, clip, clipEl, loading, onCancel, note }: {
  still: Still | null; grade: Grade; cmp: GalleryStill | null; wipe: number; setWipe: (x: number) => void;
  clip?: string; clipEl: React.RefObject<HTMLVideoElement | null>; loading: "" | "frame" | "clip"; onCancel: () => void;
  /** why there's no full quality: the viewer says it's the proxy */
  note?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !still) return;
    const id = requestAnimationFrame(() => {
      const ctx = c.getContext("2d")!;
      const img = ctx.createImageData(still.w, still.h);
      paint(img, still, grade, cmp ? { still: cmp.still, g: cmp.grade, x: wipe } : undefined);
      ctx.putImageData(img, 0, 0);
    });
    return () => cancelAnimationFrame(id);
  }, [still, grade, cmp, wipe]);
  const chip = "pointer-events-none absolute bottom-2 left-2 select-none rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white";
  if (clip) {
    return (
      <>
        <GradeFilter id="grade-hq-clip" from={SQUEEZE as Grade} to={grade} />
        <video ref={clipEl} src={clip} autoPlay loop playsInline className="absolute inset-0 h-full w-full bg-black"
          style={{ filter: "url(#grade-hq-clip)" }} onClick={(e) => (e.currentTarget.paused ? e.currentTarget.play() : e.currentTarget.pause())} />
        <span className={chip}>Full-quality clip · click to pause</span>
      </>
    );
  }
  if (loading) return <Loading what={loading} onCancel={onCancel} />;
  if (!still) return note ? <span className={cn(chip, "max-w-[90%] bg-amber-500/90 text-black")}>Proxy (8-bit preview): {note}</span> : null;
  return (
    <>
      <canvas ref={canvas} width={still.w} height={still.h} className="pointer-events-none absolute inset-0 h-full w-full" />
      <span className={chip}>Full quality{cmp ? ` | ${cmp.label}` : ""}</span>
      {cmp && (
        <div
          className="absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize touch-none"
          style={{ left: `${wipe * 100}%` }}
          onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerMove={(e) => {
            if (e.buttons !== 1) return;
            const r = e.currentTarget.parentElement!.getBoundingClientRect();
            setWipe(Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1));
          }}
          title="Drag the wipe"
        >
          <div className="mx-auto h-full w-px bg-white/80 shadow" />
        </div>
      )}
    </>
  );
}

// ---- a wheel: the ball is the balance (vectorscope directions), the ring the master ----

const WHEEL = (() => { // conic-gradient: CSS angles run clockwise from up, the vectorscope's counter-clockwise from +Cb
  const stops = Array.from({ length: 19 }, (_, k) => {
    const c = fromHue(0.55, 90 - k * 20, 0.2).map((v) => Math.round(Math.min(Math.max(v, 0), 1) * 255));
    return `rgb(${c.join(",")}) ${k * 20}deg`;
  });
  return `radial-gradient(circle, rgb(39 39 42) 0%, rgb(39 39 42 / 0) 72%), conic-gradient(${stops.join(",")})`;
})();

function Wheel({ name, v, zero, ball, ring, digits, onChange }: {
  name: string; v: RGB; zero: number; ball: number; ring: [number, number]; digits: number; onChange: (v: RGB) => void;
}) {
  const w = toWheel(v);
  const R = 36;
  const clampR = (x: number, y: number) => {
    const d = Math.hypot(x, y);
    return d > 1 ? [x / d, y / d] : [x, y];
  };
  const [bx, by] = clampR(w.cb / ball, w.cr / ball);
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const [x, y] = clampR((e.clientX - r.left - r.width / 2) / R, -(e.clientY - r.top - r.height / 2) / R);
    onChange(fromWheel(w.master, x * ball, y * ball));
  };
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[11px] text-zinc-400">{name}</span>
      <div
        className="relative h-[80px] w-[80px] cursor-crosshair touch-none rounded-full border border-zinc-700"
        style={{ background: WHEEL }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag(e); }}
        onPointerMove={(e) => e.buttons === 1 && drag(e)}
        onDoubleClick={() => onChange(fromWheel(w.master, 0, 0))}
        title={`${name} balance: drag the dot; double-click to centre it`}
      >
        <div className="absolute left-1/2 top-1/2 h-px w-3 -translate-x-1/2 bg-zinc-500" />
        <div className="absolute left-1/2 top-1/2 h-3 w-px -translate-y-1/2 bg-zinc-500" />
        <div className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black bg-white shadow"
          style={{ left: 40 + bx * R, top: 40 - by * R }} />
      </div>
      <input type="range" aria-label={`${name} master`} min={ring[0]} max={ring[1]} step={(ring[1] - ring[0]) / 400} value={w.master}
        onChange={(e) => onChange(fromWheel(Number(e.target.value), w.cb, w.cr))}
        onDoubleClick={() => onChange(fromWheel(zero, w.cb, w.cr))}
        className="h-1 w-full accent-zinc-300" title={`${name} master (the ring); double-click resets`} />
      <span className="font-mono text-[10px] tabular-nums text-zinc-400">
        <span className="text-rose-400">{v[0].toFixed(digits)}</span> <span className="text-emerald-400">{v[1].toFixed(digits)}</span>{" "}
        <span className="text-sky-400">{v[2].toFixed(digits)}</span>
      </span>
    </div>
  );
}

function Slide({ name, v, zero, range, step = 0.01, digits = 2, onChange }: {
  name: string; v: number; zero: number; range: [number, number]; step?: number; digits?: number; onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5" onDoubleClick={() => onChange(zero)} title="Double-click resets">
      <span className="flex justify-between text-[11px] text-zinc-400">{name}<span className="font-mono tabular-nums">{v.toFixed(digits)}</span></span>
      <input type="range" min={range[0]} max={range[1]} step={step} value={v} onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full accent-zinc-300" />
    </label>
  );
}

// ---- scopes: the picture being graded, small, with the new grade on; 0-110 %
// (superwhites show above 100 on the full-quality frame) ---------------------

type Mode = "wave" | "parade" | "vector";
const CW = 340;
const CH = 170;

function Scopes({ sample, show, label }: { sample: () => Sample | null; show: (c: readonly number[]) => RGB; label: string }) {
  const [mode, setMode] = useState<Mode>("parade");
  const [blocked, setBlocked] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const now = useRef({ sample, show });
  useEffect(() => {
    now.current = { sample, show };
  });

  useEffect(() => {
    const draw = () => {
      const ctx = canvas.current?.getContext("2d");
      let s: Sample | null;
      try {
        s = now.current.sample();
      } catch {
        return setBlocked(true); // a video from another origin can't be read
      }
      if (!ctx || !s) return;
      const { w: W, h: H, px } = s;
      const acc = new Float32Array(CW * CH * 3);
      const dot = (x: number, y: number, c: readonly number[]) => {
        if (x < 0 || y < 0 || x >= CW || y >= CH) return;
        const i = (Math.floor(y) * CW + Math.floor(x)) * 3;
        acc[i] += c[0];
        acc[i + 1] += c[1];
        acc[i + 2] += c[2];
      };
      const level = (v: number) => CH - 3 - (Math.min(Math.max(v, 0), TOP) / TOP) * (CH - 6);
      const third = CW / 3;
      const S = (CH / 2 - 4) / 0.45;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 3;
          const c = now.current.show([px[i], px[i + 1], px[i + 2]]);
          if (mode === "wave") dot((x / W) * CW, level(luma(c)), [0.5, 0.6, 0.5]);
          else if (mode === "parade") {
            dot((x / W) * third, level(c[0]), [0.8, 0.25, 0.25]);
            dot(third + (x / W) * third, level(c[1]), [0.25, 0.8, 0.3]);
            dot(2 * third + (x / W) * third, level(c[2]), [0.3, 0.45, 0.9]);
          } else {
            const y0 = luma(c);
            dot(CW / 2 + ((c[2] - y0) / 1.8556) * S, CH / 2 - ((c[0] - y0) / 1.5748) * S, c.map((v) => 0.25 + v * 0.6));
          }
        }
      }
      const img = ctx.createImageData(CW, CH);
      for (let p = 0; p < CW * CH; p++) {
        for (let k = 0; k < 3; k++) img.data[p * 4 + k] = 255 * (1 - Math.exp(-acc[p * 3 + k] * 0.45));
        img.data[p * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = "9px ui-monospace, monospace";
      ctx.lineWidth = 1;
      if (mode === "vector") {
        ctx.beginPath();
        ctx.arc(CW / 2, CH / 2, S * 0.45, 0, Math.PI * 2);
        ctx.moveTo(CW / 2 - 4, CH / 2);
        ctx.lineTo(CW / 2 + 4, CH / 2);
        ctx.moveTo(CW / 2, CH / 2 - 4);
        ctx.lineTo(CW / 2, CH / 2 + 4);
        ctx.stroke();
        const a = (SKIN_LINE * Math.PI) / 180; // the skin tone line
        ctx.strokeStyle = "rgba(251,191,36,0.5)";
        ctx.beginPath();
        ctx.moveTo(CW / 2, CH / 2);
        ctx.lineTo(CW / 2 + Math.cos(a) * S * 0.45, CH / 2 - Math.sin(a) * S * 0.45);
        ctx.stroke();
      } else {
        for (const v of [0, 25, 50, 75, 100]) {
          const y = Math.round(level(v / 100)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(CW, y);
          ctx.stroke();
          ctx.fillText(String(v), 2, y - 2);
        }
      }
    };
    draw();
    const t = setInterval(draw, 150);
    return () => clearInterval(t);
  }, [mode]);

  const seg = (on: boolean) => cn("rounded px-1.5 py-0.5", on ? "bg-zinc-700 text-zinc-50" : "text-zinc-400 hover:bg-zinc-800");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-0.5 text-[11px]">
        <button className={seg(mode === "wave")} onClick={() => setMode("wave")}>Waveform</button>
        <button className={seg(mode === "parade")} onClick={() => setMode("parade")}>Parade</button>
        <button className={seg(mode === "vector")} onClick={() => setMode("vector")}>Vectorscope</button>
        <span className={cn("ml-auto self-center text-[10px]", label.startsWith("proxy") ? "text-amber-400" : "text-emerald-400")}>{label}</span>
      </div>
      {blocked ? (
        <div className="flex aspect-[2/1] w-full items-center justify-center rounded bg-black text-center text-[11px] text-zinc-500">
          Scopes can't read this video
        </div>
      ) : (
        <canvas ref={canvas} width={CW} height={CH} className="w-full rounded bg-black" />
      )}
    </div>
  );
}

// ---- the live view: an SVG filter on the <video> -------------------------------

/** Turns the render (graded `from`) into `to`, exactly per channel (contracts/grade.ts `delta`). */
export function GradeFilter({ id, from, to }: { id: string; from?: Grade; to: Grade }) {
  const d = useMemo(() => {
    const x = delta(from, to);
    return { pre: satMatrix(x.pre), post: satMatrix(x.post), t: tables(x.curves) };
  }, [from, to]);
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <filter id={id} colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values={d.pre} />
        <feComponentTransfer>
          <feFuncR type="table" tableValues={d.t[0]} />
          <feFuncG type="table" tableValues={d.t[1]} />
          <feFuncB type="table" tableValues={d.t[2]} />
        </feComponentTransfer>
        <feColorMatrix type="matrix" values={d.post} />
      </filter>
    </svg>
  );
}
