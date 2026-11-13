import { useEffect, useRef, useState, type RefObject } from "react";
import type { ReviewPlayPlan } from "@/lib/plugin";
import { editedClock } from "@/lib/synced-sound";

// The talent shots of an edit played from their camera originals (the plan's `picture`), over the render: two players,
// the shot on now and the next one waiting on its first frame, on the edited timeline's clock (the sound's clock), so a
// shot made longer shows the take past the cut instead of a held frame. Where no piece is (B-roll, cards, a removed
// shot) or a piece's file isn't ready, the render shows through.

type Piece = NonNullable<ReviewPlayPlan["picture"]>[number];
const DRIFT_S = 0.12;

export function OriginalsPicture({ video, plan, holding, filter }: {
  video: RefObject<HTMLVideoElement | null>;
  plan: ReviewPlayPlan | null;
  holding: number;
  filter?: string;
}) {
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const hold = useRef(holding);
  hold.current = holding;
  const [shown, setShown] = useState<{ el: 0 | 1; piece: Piece } | null>(null);
  const pieces = plan?.picture;
  const key = pieces?.length ? JSON.stringify([plan!.fps, plan!.skips, plan!.holds, pieces]) : "";

  useEffect(() => {
    const el = video.current;
    const players = [a.current, b.current];
    if (!key || !el || !plan?.picture || !players[0] || !players[1]) return void setShown(null);
    const list = plan.picture;
    const fps = plan.fps || 25;
    const clock = editedClock(el, plan, hold);
    const loaded: (Piece | null)[] = [null, null];
    const load = (k: 0 | 1, p: Piece, at: number) => {
      const v = players[k]!;
      if (loaded[k]?.src !== p.src) v.src = p.src;
      loaded[k] = p;
      v.currentTime = at;
    };
    let last: { el: 0 | 1; piece: Piece } | null = null;
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const c = clock();
      const f = c.t * fps;
      const now = list.find((p) => f >= p.at && f < p.at + p.frames);
      const next = list.find((p) => p.at > f);
      let on: 0 | 1 | null = null;
      if (now) {
        const want = now.offset + (c.t - now.at / fps);
        on = loaded[0] === now ? 0 : loaded[1] === now ? 1 : last?.el === 0 ? 1 : 0;
        const v = players[on]!;
        if (loaded[on] !== now) load(on, now, want);
        else if (Math.abs(v.currentTime - want) > (c.run ? DRIFT_S : 0.5 / fps)) v.currentTime = want;
        v.playbackRate = c.rate;
        if (c.run && v.paused) void v.play().catch(() => {});
        if (!c.run && !v.paused) v.pause();
      }
      // the other player waits on the next shot's first frame
      const spare = on === 0 ? 1 : 0; // between shots (B-roll on screen) player 0 waits
      if (spare !== null && next && loaded[spare] !== next) {
        load(spare, next, next.offset);
        players[spare]!.pause();
      }
      const ready = on !== null && players[on]!.readyState >= 2;
      const show = now && ready && on !== null ? { el: on, piece: now } : null;
      if (show?.el !== last?.el || show?.piece !== last?.piece) setShown(show);
      last = show;
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      for (const v of players) {
        v!.pause();
        v!.removeAttribute("src");
        v!.load();
      }
      setShown(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on what plays, not on the plan object
  }, [key]);

  if (!key) return null;
  const box = (k: 0 | 1) => {
    const p = shown?.el === k ? shown.piece : null;
    return {
      left: `${(p?.x ?? 0) * 100}%`, top: `${(p?.y ?? 0) * 100}%`, width: `${(p?.s ?? 1) * 100}%`, height: `${(p?.s ?? 1) * 100}%`,
      visibility: p ? ("visible" as const) : ("hidden" as const), filter,
    };
  };
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ background: shown ? "black" : "transparent" }}>
      <video ref={a} muted playsInline preload="auto" className="absolute max-w-none object-cover" style={box(0)} />
      <video ref={b} muted playsInline preload="auto" className="absolute max-w-none object-cover" style={box(1)} />
    </div>
  );
}
