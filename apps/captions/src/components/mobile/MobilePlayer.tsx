import { useEffect, useRef, useState } from "react";
import { Loader2, Play } from "lucide-react";
import {
  activeCadenceOutcome,
  isCadenceBusy,
  isEditorBusy,
  playerRef,
  useStudio,
} from "@/lib/store";
import { fmtClock } from "@/lib/ass";
import { CaptionVisual } from "../CaptionRenderSurface";
import { CadenceProcessingStatus } from "../Player";

/**
 * Mobile video preview: video + caption overlay + a move-only caption
 * box (size lives in the style sheet) + a scrubber. Frame clock and
 * letterbox measurement mirror the desktop Player.
 */
export function MobilePlayer() {
  const videoUrl = useStudio((s) => s.videoUrl);
  const videoWidth = useStudio((s) => s.videoWidth);
  const videoHeight = useStudio((s) => s.videoHeight);
  const setVideoMeta = useStudio((s) => s.setVideoMeta);
  const setCurrentTime = useStudio((s) => s.setCurrentTime);
  const setPlaying = useStudio((s) => s.setPlaying);
  const playing = useStudio((s) => s.playing);
  const currentTime = useStudio((s) => s.currentTime);
  const duration = useStudio((s) => s.duration);
  const seek = useStudio((s) => s.seek);
  const cues = useStudio((s) => s.cues);
  const style = useStudio((s) => s.style);
  const posSegments = useStudio((s) => s.posSegments);
  const setStyle = useStudio((s) => s.setStyle);
  const srcW = useStudio((s) => s.sourceWidth || s.videoWidth);
  const srcH = useStudio((s) => s.sourceHeight || s.videoHeight);
  const refining = useStudio((s) => s.refining);
  const cadenceBusy = useStudio(isCadenceBusy);
  const editorBusy = useStudio(isEditorBusy);
  const cadenceRunOutcome = useStudio(activeCadenceOutcome);

  const wrapRef = useRef<HTMLDivElement>(null);
  const videoEl = useRef<HTMLVideoElement>(null);
  const [rect, setRect] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const [cadenceComplete, setCadenceComplete] = useState(false);
  const wasCadenceBusy = useRef(cadenceBusy);

  useEffect(() => {
    const wasBusy = wasCadenceBusy.current;
    wasCadenceBusy.current = cadenceBusy;
    if (cadenceBusy || cadenceRunOutcome !== "completed") {
      const clear = window.setTimeout(() => setCadenceComplete(false), 0);
      return () => window.clearTimeout(clear);
    }
    if (!wasBusy) return;
    const show = window.setTimeout(() => setCadenceComplete(true), 0);
    const hide = window.setTimeout(() => setCadenceComplete(false), 900);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, [cadenceBusy, cadenceRunOutcome]);

  useEffect(() => {
    playerRef.video = videoEl.current;
    return () => {
      playerRef.video = null;
    };
  }, [videoUrl]);

  useEffect(() => {
    if (!editorBusy) return;
    videoEl.current?.pause();
    setPlaying(false);
  }, [editorBusy, setPlaying]);

  // frame clock — same reasoning as the desktop Player: captions track
  // composited frames, not the playback clock
  useEffect(() => {
    const v = videoEl.current;
    if (!v) return;
    if (typeof v.requestVideoFrameCallback === "function") {
      let handle = 0;
      const tick = (_now: number, meta: VideoFrameCallbackMetadata) => {
        setCurrentTime(meta.mediaTime);
        handle = v.requestVideoFrameCallback(tick);
      };
      handle = v.requestVideoFrameCallback(tick);
      return () => v.cancelVideoFrameCallback(handle);
    }
    let raf = 0;
    const tick = () => {
      setCurrentTime(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [setCurrentTime, videoUrl]);

  // measure the letterboxed video rect
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (!videoWidth || !videoHeight) return;
      if (cw < 40 || ch < 40) return;
      const scale = Math.min(cw / videoWidth, ch / videoHeight);
      setRect({ w: videoWidth * scale, h: videoHeight * scale });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [videoWidth, videoHeight]);

  const startBoxDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isEditorBusy(useStudio.getState())) return;
    const st = useStudio.getState().style;
    const start = { x: e.clientX, y: e.clientY, bx: st.boxX, by: st.boxY };
    setDragging(true);
    const clamp = (v: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, v));
    const onMove = (ev: PointerEvent) => {
      const dx = ((ev.clientX - start.x) / rect.w) * 100;
      const dy = ((ev.clientY - start.y) / rect.h) * 100;
      setStyle({
        boxX: clamp(start.bx + dx, st.boxW / 2, 100 - st.boxW / 2),
        boxY: clamp(start.by + dy, st.boxH / 2, 100 - st.boxH / 2),
      });
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const showBox = style.fitBox && cues.length > 0 && rect.w > 0;

  return (
    <div className="flex h-full flex-col">
      <div
        ref={wrapRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-zinc-900 dark:bg-black"
      >
        {videoUrl && (
          <video
            ref={videoEl}
            src={videoUrl}
            playsInline
            className={`max-h-full max-w-full ${editorBusy ? "cursor-wait" : ""}`}
            style={{ width: rect.w || undefined, height: rect.h || undefined }}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              setVideoMeta(v.videoWidth, v.videoHeight, v.duration);
            }}
            onPlay={(e) => {
              if (editorBusy) {
                e.currentTarget.pause();
                setPlaying(false);
                return;
              }
              setPlaying(true);
            }}
            onPause={() => setPlaying(false)}
            onClick={(e) => {
              if (editorBusy) return;
              const v = e.currentTarget;
              if (v.paused) v.play();
              else v.pause();
            }}
          />
        )}

        {/* caption preview layer aligned to the video rect */}
        <div
          className="pointer-events-none absolute"
          style={{ width: rect.w, height: rect.h }}
        >
          {rect.w > 0 && (
            <CaptionVisual
              rect={rect}
              layoutWidth={srcW}
              layoutHeight={srcH}
              cues={cues}
              style={style}
              posSegments={posSegments}
              currentTime={currentTime}
            />
          )}
          {showBox && (
            <div
              onPointerDown={startBoxDrag}
              className={`pointer-events-auto absolute touch-none rounded-md border border-dashed ${
                dragging ? "border-violet-300" : "border-violet-400/50"
              }`}
              style={{
                left: `${style.boxX - style.boxW / 2}%`,
                top: `${style.boxY - style.boxH / 2}%`,
                width: `${style.boxW}%`,
                height: `${style.boxH}%`,
              }}
            >
              {refining && (
                <div className="pointer-events-none absolute -top-8 left-1/2 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded bg-zinc-900/90 px-2 py-1 text-[10px] text-zinc-300">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" /> Matching cadence…
                </div>
              )}
            </div>
          )}
        </div>

        {/* paused badge */}
        {videoUrl && !playing && !dragging && !editorBusy && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-black/45 shadow-lg backdrop-blur-sm">
              <Play className="ml-1 h-6 w-6 text-white" fill="currentColor" />
            </div>
          </div>
        )}

        {(cadenceBusy || cadenceComplete) && (
          <div
            role="status"
            aria-live="polite"
            className="absolute inset-x-3 bottom-3 z-40 flex items-center rounded-xl border border-zinc-700/80 bg-zinc-900/95 px-3 py-3 shadow-xl"
          >
            <CadenceProcessingStatus complete={cadenceComplete} />
          </div>
        )}
      </div>

      {/* scrubber */}
      <div className="flex shrink-0 items-center gap-2.5 bg-zinc-925 px-3.5 py-2.5">
        <span className="w-10 text-right font-mono text-[11px] tabular-nums text-zinc-400">
          {fmtClock(currentTime)}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(duration, 0.01)}
          step={0.01}
          value={Math.min(currentTime, duration || currentTime)}
          disabled={editorBusy}
          onInput={(e) => seek(Number(e.currentTarget.value))}
          className="h-1.5 min-w-0 flex-1 accent-violet-500 disabled:opacity-40"
        />
        <span className="w-10 font-mono text-[11px] tabular-nums text-zinc-500">
          {fmtClock(duration)}
        </span>
      </div>
    </div>
  );
}
