import { useEffect, useRef, useState } from "react";
import type { ReviewPlayCard } from "@/lib/plugin";

/**
 * A plug-in's planned edits drawn over Review's video while it plays: the top video layer's card fills the picture where
 * a B-roll shot, a graphic or a placeholder goes (its frames are not in this render), the rest shows as chips, a gone
 * card says so, and a held shot says how long it holds. A card with `src` plays that clip in place of the card, in sync,
 * muted; the server of that clip decides whether this person may see it, and the card stays when it refuses.
 * Skips, holds and reframes are the player's own (they move the video itself; see lib/review-play.ts).
 */
export function PlanOverlay({ cards, fps, time, holding, playing = false, rate = 1 }: {
  cards: ReviewPlayCard[]; fps: number; time: number; holding: number; playing?: boolean; rate?: number;
}) {
  const [refused, setRefused] = useState<string[]>([]);
  const f = Math.floor(time * fps + 1e-3); // the frame on screen
  const now = cards.filter((c) => f >= c.from && f < c.to);
  const picture = now
    .filter((c) => c.track[0] === "V" && c.kind !== "gone")
    .sort((a, b) => Number(b.track.slice(1)) - Number(a.track.slice(1)))[0];
  const chips = now.filter((c) => c !== picture);
  // the real clips playing now or starting within 2 s (loaded ahead, so they're ready)
  const reels = cards.filter((c) => c.src && !refused.includes(c.src) && c.to > f && c.from - f < 2 * fps);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden text-white">
      {picture && <Cover c={picture} />}
      {reels.map((c) => (
        <Reel key={`${c.src}@${c.from}`} c={c} f={f} fps={fps} active={c === picture} playing={playing} rate={rate}
          onRefused={() => setRefused((r) => [...r, c.src!])} />
      ))}
      {(chips.length > 0 || holding > 0) && (
        <div className="absolute left-2 top-2 flex max-w-[85%] flex-col items-start gap-1">
          {holding > 0 && <Chip tone="bg-amber-500/90 text-black">Held +{holding} f: the shot runs on here</Chip>}
          {chips.map((c, i) => (
            <Chip key={i} tone={c.kind === "gone" ? "bg-rose-600/85" : "bg-teal-700/90"}>
              {c.kind === "gone" ? `✕ ${c.label}: not here any more` : `♪ ${c.track} ${c.label}`}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

/** One clip, muted, kept at the second the timeline says (a new link when the old one ran out; failing again within a minute, the card stays). */
function Reel({ c, f, fps, active, playing, rate, onRefused }: {
  c: ReviewPlayCard; f: number; fps: number; active: boolean; playing: boolean; rate: number; onRefused: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [retry, setRetry] = useState(0);
  const want = Math.max(0, (c.at ?? 0) + Math.max(0, f - c.from) / fps);
  useEffect(() => {
    const el = ref.current;
    if (!el || el.readyState < 1) return;
    el.playbackRate = rate;
    // while both play, only a real drift is corrected; paused or scrubbing, every frame
    if (Math.abs(el.currentTime - want) > (active && playing ? 0.3 : 0.04)) el.currentTime = want;
    if (active && playing) {
      if (el.paused) void el.play().catch(() => {});
    } else if (!el.paused) el.pause();
  });
  return (
    <video ref={ref} muted playsInline preload="auto"
      src={`${c.src}${retry ? `?r=${retry}` : ""}`}
      onLoadedMetadata={(e) => (e.currentTarget.currentTime = want)}
      onError={() => (retry && Date.now() - retry < 60_000 ? onRefused() : setRetry(Date.now()))}
      className={`absolute inset-0 h-full w-full object-cover ${active ? "opacity-100" : "opacity-0"}`} />
  );
}

const Chip = ({ tone, children }: { tone: string; children: React.ReactNode }) => (
  <span className={`max-w-full truncate rounded px-1.5 py-0.5 text-[11px] font-medium shadow ${tone}`}>{children}</span>
);

function Cover({ c }: { c: ReviewPlayCard }) {
  const what = c.kind === "hole" ? "Placeholder" : c.track === "V2" ? "B-roll" : "Graphic";
  const label = (
    <div className="max-w-[85%] text-center">
      <div className="text-[10px] font-semibold uppercase tracking-wider opacity-70">{what} · {c.track}</div>
      <div className="mt-1 text-sm font-medium leading-snug">{c.label}</div>
    </div>
  );
  if (c.look === "solid") {
    return <div className="absolute inset-0 grid place-items-center" style={{ background: c.color ?? "#6d28d9" }}>{label}</div>;
  }
  if (c.look === "outline") {
    return (
      <div className="absolute inset-3 flex items-end justify-center rounded border-2 border-dashed border-amber-300 pb-3">
        <div className="rounded bg-black/70 px-2 py-1">{label}</div>
      </div>
    );
  }
  const tone = c.kind === "hole" ? "bg-zinc-950/90 border-amber-300" : c.track === "V2" ? "bg-sky-950/90 border-sky-400" : "bg-amber-950/90 border-amber-400";
  return <div className={`absolute inset-0 grid place-items-center border-4 border-dashed ${tone}`}>{label}</div>;
}
