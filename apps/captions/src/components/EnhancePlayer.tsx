import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play, Sparkles } from "lucide-react";
import { isEnhancing, playUrl, type EnhanceSession } from "@/lib/enhance";

/**
 * The Audio Enhancer's player: waveform, scrub-to-seek, a prominent
 * Before/After toggle and the strength slider. Both tracks play together through Web Audio
 * gains, the original leading and the result held to it, so flipping or
 * sliding mid-play is instant and keeps the playhead. After = the blend at
 * the strength picked; both are at the same loudness (api/enhance.ts), so
 * the slider moves the sound, not the volume.
 */

type Track = "original" | "enhanced";

const BAR_GAP = 1;
/** The result is put back on the original's time when it drifts further. */
const DRIFT_S = 0.05;
const BAR_W = 2;

/** Decode an audio URL into normalized waveform peaks. */
async function loadPeaks(url: string, buckets = 700): Promise<Float32Array> {
  const buf = await fetch(url).then((r) => {
    if (!r.ok) throw new Error("waveform fetch failed");
    return r.arrayBuffer();
  });
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(buf);
    const ch = decoded.getChannelData(0);
    const peaks = new Float32Array(buckets);
    const step = Math.max(1, Math.floor(ch.length / buckets));
    let overall = 0;
    for (let i = 0; i < buckets; i++) {
      let max = 0;
      const start = i * step;
      const end = Math.min(ch.length, start + step);
      for (let j = start; j < end; j += 8) {
        const v = Math.abs(ch[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
      if (max > overall) overall = max;
    }
    if (overall > 0) for (let i = 0; i < buckets; i++) peaks[i] /= overall;
    return peaks;
  } finally {
    ctx.close().catch(() => {});
  }
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function EnhancePlayer({ session, mix, onMix }: {
  session: EnhanceSession;
  /** the result's share against the original, 0..1 */
  mix: number;
  onMix: (v: number) => void;
}) {
  const [track, setTrack] = useState<Track>(
    session.hasEnhanced ? "enhanced" : "original"
  );
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(session.duration || 0);
  const [peaks, setPeaks] = useState<Partial<Record<Track, Float32Array>>>({});

  const origRef = useRef<HTMLAudioElement>(null);
  const enhRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const graph = useRef<{ ctx: AudioContext; orig: GainNode; enh: GainNode } | null>(null);

  const both = () => [origRef.current, session.hasEnhanced ? enhRef.current : null].filter((a): a is HTMLAudioElement => !!a);

  // the two tracks' shares: Before = the original alone, After = the blend
  const shares = track === "enhanced" && session.hasEnhanced ? [1 - mix, mix] : [1, 0];
  useEffect(() => {
    const g = graph.current;
    if (!g) return;
    g.orig.gain.setTargetAtTime(shares[0], g.ctx.currentTime, 0.015);
    g.enh.gain.setTargetAtTime(shares[1], g.ctx.currentTime, 0.015);
  }, [shares[0], shares[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Route both elements through gains, once, on the first play (a user gesture). */
  const ensureGraph = () => {
    if (graph.current || !origRef.current || !enhRef.current) return graph.current;
    try {
      const ctx = new AudioContext();
      const [orig, enh] = [ctx.createGain(), ctx.createGain()];
      ctx.createMediaElementSource(origRef.current).connect(orig).connect(ctx.destination);
      ctx.createMediaElementSource(enhRef.current).connect(enh).connect(ctx.destination);
      orig.gain.value = shares[0];
      enh.gain.value = shares[1];
      origRef.current.volume = enhRef.current.volume = 1; // the gains carry it now, not the fallback's volumes
      graph.current = { ctx, orig, enh };
    } catch {
      /* no Web Audio: element volumes below */
    }
    return graph.current;
  };
  useEffect(() => () => void graph.current?.ctx.close().catch(() => {}), []);
  // without Web Audio the elements' own volumes carry the blend (not on iOS)
  useEffect(() => {
    if (graph.current) return;
    if (origRef.current) origRef.current.volume = shares[0];
    if (enhRef.current) enhRef.current.volume = shares[1];
  }, [shares[0], shares[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  // updatedAt ticks on every progress write, so it can't key the media
  // directly — the src would churn each poll and reset playback. The
  // version freezes while a job runs and lands on the final updatedAt
  // when it completes, which is exactly when the result changed.
  const version = isEnhancing(session) ? "pending" : String(session.updatedAt);

  // run completed → play the fresh result, drop its stale waveform
  // (adjust-during-render pattern — no effect, no cascading renders)
  const [prevVersion, setPrevVersion] = useState(version);
  if (version !== prevVersion) {
    setPrevVersion(version);
    if (version !== "pending" && session.hasEnhanced) {
      setPeaks((prev) => ({ original: prev.original }));
      setTrack("enhanced");
    }
  }

  // decode the active track's waveform once (and the other lazily too,
  // so the first flip doesn't blank the display)
  useEffect(() => {
    let gone = false;
    const want: Track[] = session.hasEnhanced
      ? ["enhanced", "original"]
      : ["original"];
    for (const t of want) {
      if (peaks[t]) continue;
      const buster = t === "enhanced" ? `&v=${version}` : "";
      loadPeaks(playUrl(session.id, t) + buster)
        .then((p) => {
          if (!gone) setPeaks((prev) => ({ ...prev, [t]: p }));
        })
        .catch(() => {});
    }
    return () => {
      gone = true;
    };
  }, [session.id, session.hasEnhanced, version, peaks]);

  // progress loop while playing: the original leads, the result follows it
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const [a, b] = [origRef.current, session.hasEnhanced ? enhRef.current : null];
      if (a) {
        setTime(a.currentTime);
        if (b && !b.seeking && Math.abs(b.currentTime - a.currentTime) > DRIFT_S) b.currentTime = a.currentTime;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, session.hasEnhanced]);

  // waveform rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = 72;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);
      const data = peaks[track];
      const bars = Math.floor(w / (BAR_W + BAR_GAP));
      const playedX = duration > 0 ? (time / duration) * w : 0;
      const rest = `rgb(${getComputedStyle(document.documentElement).getPropertyValue("--zinc-700")})`; // follows the theme
      for (let i = 0; i < bars; i++) {
        const x = i * (BAR_W + BAR_GAP);
        let v = 0.06;
        if (data) {
          const di = Math.floor((i / bars) * data.length);
          v = Math.max(0.06, data[di] * 0.95);
        }
        const bh = v * h;
        ctx.fillStyle = x <= playedX ? "#8b5cf6" : rest;
        ctx.beginPath();
        ctx.roundRect(x, (h - bh) / 2, BAR_W, bh, 1);
        ctx.fill();
      }
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [peaks, track, time, duration]);

  // both play all the time; the toggle only moves the gains
  const toggle = (t: Track) => setTrack(t);

  const playPause = () => {
    const a = origRef.current;
    if (!a) return;
    if (a.paused) {
      const g = ensureGraph();
      void g?.ctx.resume();
      for (const b of both()) {
        if (b !== a) b.currentTime = a.currentTime;
        void b.play().catch(() => {});
      }
    } else {
      for (const b of both()) b.pause();
    }
  };

  const seekAt = (clientX: number) => {
    const wrap = wrapRef.current;
    if (!wrap || duration <= 0) return;
    const rect = wrap.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    for (const b of both()) b.currentTime = frac * duration;
    setTime(frac * duration);
  };

  const onScrub = (e: React.PointerEvent) => {
    e.preventDefault();
    seekAt(e.clientX);
    const move = (ev: PointerEvent) => seekAt(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const audioProps = (t: Track) => ({
    preload: "auto" as const,
    // the original never changes; the enhanced file does on re-runs
    src: t === "enhanced" && !session.hasEnhanced ? undefined : playUrl(session.id, t) + (t === "enhanced" ? `&v=${version}` : ""),
    // the original leads: its play/pause/end is the player's
    onPlay: () => t === "original" && setPlaying(true),
    onPause: () => t === "original" && setPlaying(false),
    onEnded: () => {
      if (t === "original") {
        enhRef.current?.pause();
        setPlaying(false);
        setTime(duration);
      }
    },
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLAudioElement>) => {
      if (!duration && Number.isFinite(e.currentTarget.duration)) {
        setDuration(e.currentTarget.duration);
      }
    },
  });

  const waveLoading = !peaks[track];

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      {/* both always mounted: Web Audio takes each element once */}
      <audio ref={origRef} {...audioProps("original")} />
      <audio ref={enhRef} {...audioProps("enhanced")} />

      {/* before/after — the hero control */}
      <div className="mb-3 flex justify-center">
        <div className="flex rounded-full bg-zinc-900 p-1">
          <button
            onClick={() => toggle("original")}
            className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${
              track === "original"
                ? "bg-zinc-700 text-zinc-50"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Before
          </button>
          <button
            onClick={() => toggle("enhanced")}
            disabled={!session.hasEnhanced}
            className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              track === "enhanced"
                ? "bg-violet-600 text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Sparkles className="h-3 w-3" /> After
          </button>
        </div>
      </div>

      <div
        ref={wrapRef}
        onPointerDown={onScrub}
        className="relative cursor-pointer touch-none"
        title="Click or drag to seek"
      >
        <canvas ref={canvasRef} className="block w-full" />
        {waveLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-zinc-600" />
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={playPause}
          aria-label={playing ? "Pause" : "Play"}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white transition-colors hover:bg-violet-500"
        >
          {playing ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="ml-0.5 h-4 w-4" />
          )}
        </button>
        <span className="text-xs tabular-nums text-zinc-400">
          {fmtTime(time)}{" "}
          <span className="text-zinc-600">/ {fmtTime(duration)}</span>
        </span>
        {session.hasEnhanced && (
          <span className="ml-auto text-[11px] text-zinc-500">
            Flip Before/After while playing to compare
          </span>
        )}
      </div>

      {session.hasEnhanced && (
        <div className="mt-4 flex items-center gap-3">
          <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-zinc-500">Strength</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(mix * 100)}
            onChange={(e) => {
              onMix(Number(e.target.value) / 100);
              setTrack("enhanced");
            }}
            aria-label="Strength: how much of the enhanced voice against the original"
            className="h-1.5 flex-1 cursor-pointer accent-violet-500"
          />
          <span className="w-10 shrink-0 text-right text-xs tabular-nums text-zinc-300">{Math.round(mix * 100)}%</span>
        </div>
      )}
    </div>
  );
}
