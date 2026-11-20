import { useEffect, useRef, useState } from "react";
import { onMeter, resetMeter, type MeterRead, type NleClock } from "@/lib/nle/audio";
import { cn } from "@/lib/utils";

// The loudness meter at the right of the timeline (Resolve's Loudness panel): the master bus's peak bars, L and R, and
// Momentary / Short-term / Integrated LUFS with True Peak, as the AudioWorklet reads them (lib/nle/loudness.ts). Each read
// is shown as it comes, never eased. Integrated starts over when the playhead jumps (a seek, Play from elsewhere) and on a
// click; it is amber when it is more than 1 LU from the mix's target.

/** The mix's loudness target (LUFS): social video. */
export const MIX_TARGET = -14;
const FLOOR = -60;
const TICKS = [0, -6, -12, -18, -24, -36, -48];

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const show = (l: number) => (Number.isFinite(l) && l > -70 ? l.toFixed(1) : "–");
const height = (d: number) => `${Math.max(0, Math.min(1, (d - FLOOR) / -FLOOR)) * 100}%`;
const colour = (d: number) => (d > -3 ? "bg-red-500" : d > -9 ? "bg-amber-400" : "bg-emerald-500");

export function NleMeter({ clock, target = MIX_TARGET }: { clock: NleClock; target?: number }) {
  const [r, setR] = useState<MeterRead | null>(null);
  const last = useRef(0);
  useEffect(() => {
    const off = onMeter((x) => {
      last.current = clock.now();
      setR(x);
    });
    // a start more than a few frames from where the last read was: what it measures from here is another piece
    const offA = clock.onAnchor(() => {
      if (clock.state === "running" && Math.abs(clock.now() - last.current) > 0.2) resetMeter();
    });
    return () => (off(), offA());
  }, [clock]);
  const off = r && Number.isFinite(r.i) && Math.abs(r.i - target) > 1;
  const row = (label: string, v: string, cls?: string) => (
    <div className="flex justify-between gap-1"><span className="text-zinc-500">{label}</span><span className={cn("tabular-nums", cls)}>{v}</span></div>
  );
  return (
    <div className="flex w-[76px] shrink-0 select-none flex-col gap-2 border-l border-zinc-800 bg-zinc-950 px-1.5 py-2 text-[10px] text-zinc-300" aria-label="Loudness">
      <div className="relative flex min-h-16 flex-1 gap-1 pl-5">
        {TICKS.map((t) => (
          <span key={t} className="absolute left-0 -translate-y-1/2 text-[9px] text-zinc-600 tabular-nums" style={{ bottom: height(t) }}>{t}</span>
        ))}
        {[0, 1].map((c) => {
          const d = db(r?.pk[c] ?? 0);
          return (
            <div key={c} className="relative flex-1 overflow-hidden rounded-sm bg-zinc-800" aria-label={c ? "Right" : "Left"}>
              <div className={cn("absolute inset-x-0 bottom-0", colour(d))} style={{ height: height(d) }} />
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-0.5">
        {row("M", show(r?.m ?? -Infinity))}
        {row("S", show(r?.s ?? -Infinity))}
        <button type="button" title={`Integrated loudness since Play (target ${target} LUFS). Click to start over`} onClick={resetMeter} className="text-left">
          {row("I", show(r?.i ?? -Infinity), off ? "text-amber-400" : undefined)}
        </button>
        {row("TP", show(r?.tp ?? -Infinity), r && r.tp > -1 ? "text-red-400" : undefined)}
        <span className="text-right text-zinc-600">LUFS</span>
      </div>
    </div>
  );
}
