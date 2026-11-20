import { useEffect, useRef } from "react";
import type { NleClock } from "@/lib/nle/audio";

/** How far the render may drift from the playhead before it is put back (seconds). */
const DRIFT_S = 0.12;

/**
 * The timeline's render over the Viewer's frame (Rendered): what the server drew, its texts and effects, following the
 * playhead. Silent: the sound stays the timeline's own, played by the editor.
 */
export function NleRendered({ url, clock, playing }: { url: string; clock: NleClock; playing: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (playing) void v.play().catch(() => {});
    else v.pause();
    const follow = (t: number) => {
      if (Math.abs(v.currentTime - t) > (playing ? DRIFT_S : 1e-3)) v.currentTime = t;
    };
    follow(clock.now());
    return clock.subscribe(follow);
  }, [clock, playing, url]);
  return <video ref={video} src={url} muted playsInline preload="auto" aria-label="Rendered" className="pointer-events-none absolute inset-0 h-full w-full bg-black object-contain" />;
}
