import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { Loader2, Pause, Play } from "lucide-react";
import {
  DEFAULT_EDIT,
  cropGeometry,
  type EditOptions,
} from "@contracts/clean-edit";
import {
  editTimeline,
  sourceMoment,
  timelineDuration,
} from "@contracts/clean-timeline";
import { previewEditFrame } from "@/lib/clean-edit";

export interface CleanPreviewHandle {
  seek: (seconds: number) => void;
  toggle: () => void;
}

export function CleanEditorPreview({
  url,
  sourceId,
  options,
  sourceDuration,
  busy,
  onDuration,
  transportRef,
  onTimeChange,
  editAction,
  suspended = false,
  readOnly = false,
}: {
  url: string;
  sourceId?: string;
  options: EditOptions;
  sourceDuration: number;
  busy: boolean;
  onDuration: (duration: number) => void;
  transportRef?: Ref<CleanPreviewHandle>;
  onTimeChange?: (seconds: number) => void;
  editAction?: ReactNode;
  suspended?: boolean;
  /** No server-rendered frames (the demo). */
  readOnly?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const a = options.adjustments;
  const latest = useRef(a);
  useEffect(() => {
    latest.current = a;
  }, [a]);
  const [playing, setPlaying] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [duration, setDuration] = useState(sourceDuration);
  const [failed, setFailed] = useState(false);
  const [listenOriginal, setListenOriginal] = useState(false);
  const [frame, setFrame] = useState<{ key: string; url: string }>();
  const [frameError, setFrameError] = useState("");
  const [verifyFrame, setVerifyFrame] = useState(false);
  const frameUrl = useRef<string>(undefined);
  const timelineKey = JSON.stringify([
    a.cuts,
    a.start,
    a.end,
    a.speed,
    sourceDuration || duration,
  ]);
  const spans =
    (sourceDuration || duration) > 0
      ? editTimeline(a, sourceDuration || duration)
      : [{ start: 0, end: 0, outputStart: 0, outputEnd: 0 }];
  const sceneRef = useRef(0);
  const [sceneIndex, setSceneIndex] = useState(0);
  const scene = spans[Math.min(sceneIndex, spans.length - 1)];
  const end = scene.end;
  const outputDuration = timelineDuration(spans);
  const outputTime = Math.max(
    scene.outputStart,
    Math.min(
      scene.outputEnd,
      scene.outputStart + (seconds - scene.start) / a.speed,
    ),
  );
  useEffect(() => {
    // Keep the current source moment when it survives a trim/reorder/rate edit.
    const current =
      video.current && video.current.readyState >= 1
        ? video.current.currentTime
        : spans[0].start;
    const retained = spans.findIndex(
      (s) => current >= s.start && current < s.end,
    );
    const index = retained < 0 ? 0 : retained;
    const at = retained < 0 ? spans[0].start : current;
    sceneRef.current = index;
    setSceneIndex(index);
    setSeconds(at);
    if (video.current) video.current.currentTime = at;
    // The key includes every timeline field, including duration when it becomes known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineKey]);
  function advanceScene(v: HTMLVideoElement) {
    const index = sceneRef.current;
    const span = spans[index];
    if (!span || v.currentTime < span.end - 0.025) return;
    if (index + 1 < spans.length) {
      sceneRef.current = index + 1;
      setSceneIndex(index + 1);
      v.currentTime = spans[index + 1].start;
    } else v.pause();
  }
  useEffect(() => {
    if (suspended) video.current?.pause();
  }, [suspended]);
  useEffect(() => {
    onTimeChange?.(outputTime);
  }, [outputTime, onTimeChange]);
  const time = Math.max(
    scene.start,
    Math.min(seconds, Math.max(scene.start, end - 0.04)),
  );
  const frameKey = JSON.stringify({
    options: {
      ...DEFAULT_EDIT,
      adjustments: { ...a, speed: 1, volume: 1, mute: false },
    },
    seconds: Math.floor(time * 1_000_000) / 1_000_000,
  });

  function paint() {
    const v = video.current,
      c = canvas.current;
    if (!v || !c || v.readyState < 2 || !v.videoWidth) return;
    const settings = latest.current;
    const g = cropGeometry(v.videoWidth, v.videoHeight, settings);
    const scale = Math.min(1, 960 / Math.max(g.outputWidth, g.outputHeight));
    const w = Math.max(1, Math.round(g.outputWidth * scale)),
      h = Math.max(1, Math.round(g.outputHeight * scale));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const context = c.getContext("2d");
    if (!context) return;
    context.save();
    context.clearRect(0, 0, w, h);
    context.translate(w / 2, h / 2);
    context.rotate((settings.rotate * Math.PI) / 180);
    context.scale(settings.flipH ? -1 : 1, settings.flipV ? -1 : 1);
    context.drawImage(
      v,
      g.x,
      g.y,
      g.width,
      g.height,
      (-g.width * scale) / 2,
      (-g.height * scale) / 2,
      g.width * scale,
      g.height * scale,
    );
    context.restore();
  }
  useEffect(() => {
    // Coalesce slider changes into one paint per display frame. Color is applied
    // by the compositor below instead of filtering video pixels on the CPU.
    const frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [url, a]);
  useEffect(() => {
    if (!playing || video.current?.requestVideoFrameCallback) return;
    let animation = 0;
    const tick = () => {
      paint();
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing]);
  useEffect(() => {
    const v = video.current;
    if (!v?.requestVideoFrameCallback) return;
    let callback = 0;
    const presented: VideoFrameRequestCallback = (_now, metadata) => {
      if (!v.paused) advanceScene(v);
      paint();
      // A seek can land between timestamps. Use the displayed frame's timestamp
      // for the paused server comparison instead of requesting the next frame.
      if (v.paused) setSeconds(metadata.mediaTime);
      callback = v.requestVideoFrameCallback(presented);
    };
    callback = v.requestVideoFrameCallback(presented);
    return () => v.cancelVideoFrameCallback(callback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, timelineKey]);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.playbackRate = a.speed;
    v.volume = listenOriginal ? 1 : a.volume;
    v.muted = !listenOriginal && a.mute;
  }, [a.speed, a.volume, a.mute, listenOriginal]);
  useEffect(() => {
    if (readOnly || !verifyFrame || !sourceId || playing || busy || !end)
      return;
    const controller = new AbortController();
    const request = JSON.parse(frameKey) as {
      options: EditOptions;
      seconds: number;
    };
    const timer = setTimeout(() => {
      void previewEditFrame(
        sourceId,
        request.options,
        request.seconds,
        controller.signal,
      )
        .then((blob) => {
          if (controller.signal.aborted) return;
          const next = URL.createObjectURL(blob);
          if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
          frameUrl.current = next;
          setFrame({ key: frameKey, url: next });
          setFrameError("");
        })
        .catch((error: Error) => {
          if (!controller.signal.aborted) setFrameError(error.message);
        });
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [readOnly, verifyFrame, sourceId, frameKey, playing, busy, end]);
  useEffect(
    () => () => {
      if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
    },
    [],
  );
  const exact = verifyFrame && !playing && frame?.key === frameKey;
  function seek(value: number) {
    video.current?.pause();
    setPlaying(false);
    const index = Math.max(
      0,
      spans.findIndex((span) => value < span.outputEnd),
    );
    sceneRef.current = value >= outputDuration ? spans.length - 1 : index;
    setSceneIndex(sceneRef.current);
    const source = sourceMoment(spans, value, a.speed);
    setSeconds(source);
    if (video.current && !failed) video.current.currentTime = source;
  }
  function toggle() {
    const v = video.current;
    if (!v || failed || suspended) return;
    if (!v.paused) v.pause();
    else {
      if (sceneRef.current === spans.length - 1 && v.currentTime >= end - 0.05)
        seek(0);
      void v.play().catch(() => setPlaying(false));
    }
  }
  useImperativeHandle(transportRef, () => ({ seek, toggle }));
  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
      <div className="grid grid-cols-2 divide-x divide-zinc-800">
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-3 text-xs">
            <span className="font-medium">Original</span>
            <span className="text-zinc-500">Unchanged picture</span>
          </div>
          <div className="flex aspect-video items-center justify-center bg-black">
            <video
              ref={video}
              src={url}
              playsInline
              preload="auto"
              aria-label="Original video preview"
              className={`h-full w-full object-contain ${failed ? "hidden" : ""}`}
              onLoadedMetadata={() => {
                const d = video.current?.duration;
                if (d && Number.isFinite(d)) {
                  setDuration(d);
                  onDuration(d);
                }
                sceneRef.current = 0;
                setSceneIndex(0);
                setSeconds(spans[0].start);
                if (video.current) video.current.currentTime = spans[0].start;
              }}
              onLoadedData={paint}
              onSeeked={() => {
                if (video.current) setSeconds(video.current.currentTime);
                paint();
              }}
              onTimeUpdate={() => {
                const v = video.current;
                if (!v) return;
                if (!v.paused) advanceScene(v);
                setSeconds(v.currentTime);
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => {
                const v = video.current;
                const next = sceneRef.current + 1;
                // A scene can finish at the physical end of the source. There
                // may be no video-frame callback after the last displayed frame.
                if (v && next < spans.length) {
                  sceneRef.current = next;
                  setSceneIndex(next);
                  v.currentTime = spans[next].start;
                  void v.play().catch(() => setPlaying(false));
                } else setPlaying(false);
              }}
              onError={() => {
                setFailed(true);
                setVerifyFrame(true);
              }}
            />
            {failed && (
              <p className="p-3 text-center text-xs text-zinc-500">
                This codec cannot play in your browser. Rendered frames and
                export are still available.
              </p>
            )}
          </div>
        </div>
        <div className="min-w-0">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-3 text-xs">
            <span className="flex items-center gap-2 font-medium text-violet-200">
              Current edit {editAction}
            </span>
            <span className="flex items-center gap-1 text-zinc-500">
              {exact ? (
                "Rendered frame"
              ) : readOnly ||
                !verifyFrame ||
                playing ||
                !sourceId ||
                frameError ||
                busy ? (
                "Instant preview"
              ) : (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" /> Updating frame
                </>
              )}
            </span>
          </div>
          <div className="relative flex aspect-video items-center justify-center bg-black">
            <canvas
              ref={canvas}
              aria-label="Edited video preview"
              className="max-h-full max-w-full object-contain"
              style={{
                visibility: exact ? "hidden" : "visible",
                filter: `brightness(${a.brightness}) contrast(${a.contrast}) saturate(${a.saturation})`,
              }}
            />
            {exact && (
              <img
                src={frame.url}
                alt="Current edit rendered with export settings"
                className="absolute h-full w-full object-contain"
              />
            )}
          </div>
        </div>
      </div>
      <div className="border-t border-zinc-800 px-3 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={failed}
            aria-label={playing ? "Pause comparison" : "Play comparison"}
            onClick={toggle}
            className="rounded-lg bg-zinc-800 p-2 text-white disabled:opacity-30"
          >
            {playing ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </button>
          <input
            aria-label="Comparison timeline"
            type="range"
            min={0}
            max={Math.max(0.1, outputDuration)}
            step={0.01}
            value={outputTime}
            disabled={!end}
            onChange={(e) => seek(Number(e.target.value))}
            className="min-w-0 flex-1 accent-violet-500"
          />
          <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">
            {outputTime.toFixed(2)}s / {outputDuration.toFixed(2)}s
          </span>
        </div>
        <div className="mt-3 flex flex-wrap justify-between gap-2 text-[11px] text-zinc-500">
          <span>
            Source {time.toFixed(2)}s · scene {sceneIndex + 1} / {spans.length}{" "}
            · both views stay in sync
          </span>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={listenOriginal}
              onChange={(e) => setListenOriginal(e.target.checked)}
              className="accent-violet-500"
            />{" "}
            Listen to original audio
          </label>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
          Adjustments preview immediately on your device. Full measurements and
          downloads use the encoded output.
        </p>
        {!readOnly && (
          <label className="mt-3 flex items-center gap-2 text-[11px] text-zinc-400">
            <input
              type="checkbox"
              checked={verifyFrame}
              onChange={(event) => setVerifyFrame(event.target.checked)}
              className="accent-violet-500"
            />
            Verify paused frames with export filters
          </label>
        )}
        {verifyFrame && !readOnly && (
          <p className="mt-1 text-[11px] text-zinc-500">
            Optional server render. New adjustments replace older requests; the
            instant preview stays responsive.
          </p>
        )}
        {verifyFrame && frameError && (
          <p className="mt-2 text-[11px] text-amber-300">
            Rendered frame: {frameError}
          </p>
        )}
      </div>
    </section>
  );
}
