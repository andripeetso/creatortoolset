import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import { ChevronLeft, ChevronRight, Download, Loader2, Volume2 } from "lucide-react";
import { SPRITE_FRAMES, type AssetCard, type AssetDetail } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { across, clock, frameAt, frameStyle } from "./ClipCards";
import { copyReady, original, playerNote, type PlayerNote } from "./clip";

/**
 * The clip's player, at the top of its panel. It starts playing as it opens: with sound where the window allows that,
 * else muted with a Sound on button. The clip's picture shows under it until the first frame is there. A file this
 * window cannot decode says so in the player's place; while its lighter copy is being made the panel's detail says so
 * (read again on each library change), and the player starts once the copy is there: the same play address then
 * serves the copy. Under a video, its strip of frames (Filmstrip).
 */

type Phase = "loading" | "playing" | "paused" | "failed";

export function ClipPlayer({
  asset: a,
  detail,
  media,
  startAt,
  onPrev,
  onNext,
  onTime,
  fill = false,
}: {
  asset: AssetCard;
  detail: AssetDetail | null;
  media: RefObject<(HTMLVideoElement & HTMLAudioElement) | null>;
  startAt: number;
  onPrev?: () => void;
  onNext?: () => void;
  /** the second playing now, for the transcript's mark */
  onTime?: (s: number) => void;
  /** in the window: the player takes the whole left side (on a phone, the top) */
  fill?: boolean;
}) {
  const [muted, setMuted] = useState(false);
  // the plain address failed: once the lighter copy is made it is asked for again, at a new address (`?r=1`) so the
  // window does not answer from what it kept of the failed one
  const [plainFailed, setPlainFailed] = useState(false);
  const retry = plainFailed && copyReady(detail);
  const src = `/api/library/media/${a.versionId}/play${retry ? "?r=1" : ""}${startAt ? `#t=${startAt}` : ""}`;
  // what the element at `src` last said; a new address starts as loading
  const [seen, setSeen] = useState<{ src: string; phase: Phase }>({ src: "", phase: "loading" });
  const phase = seen.src === src ? seen.phase : "loading";
  const to = (p: Phase) => setSeen({ src, phase: p });
  const [now, setNow] = useState(startAt);

  useEffect(() => {
    const v = media.current;
    if (!v) return;
    v.play().catch((e: unknown) => {
      // a file it cannot play says so through `error`; an abort is the panel moving on
      if ((e as DOMException)?.name !== "NotAllowedError") return;
      v.muted = true;
      setMuted(true);
      void v.play().catch(() => {});
    });
  }, [src, media]);

  // a missing original is explained under the title, once; the player keeps its picture
  const said = phase === "failed" ? playerNote(detail?.state ?? a.state, detail) : null;
  const note = said === "missing" ? null : said;
  const picture = a.thumbUrl;

  const events = {
    onPlaying: () => to("playing"),
    onPause: () => to("paused"),
    onWaiting: () => to("loading"),
    onError: () => {
      if (!retry) setPlainFailed(true);
      to("failed");
    },
    onVolumeChange: () => setMuted(!!media.current?.muted),
    onTimeUpdate: () => {
      const t = media.current?.currentTime ?? 0;
      setNow(t);
      onTime?.(t);
    },
  };

  if (a.kind === "audio" && !fill) {
    return (
      <>
        <audio key={src} ref={media} src={src} controls preload="auto" className="w-full" {...events} />
        {note && <Note note={note} file={original(a, detail)} />}
      </>
    );
  }

  // the box has the clip's own shape (an upright clip stands upright), at most so tall; in the window it fills its side
  const shape = { "--ar": a.width && a.height ? `${a.width} / ${a.height}` : "16 / 9" } as CSSProperties;
  const strip = a.kind === "video" && a.spriteUrl && a.durationS ? { url: a.spriteUrl, duration: a.durationS } : null;
  return (
    // the player, and under a video its strip; in the window the player takes what the strip leaves
    <div className={cn("flex w-full flex-col", fill ? "md:h-full" : "gap-1.5")}>
      <div
        className={cn(
          "relative w-full overflow-hidden bg-black bg-contain bg-center bg-no-repeat",
          a.kind === "audio" ? "h-40 md:h-auto" : "aspect-[var(--ar)]",
          fill ? "max-h-[45dvh] md:min-h-0 md:flex-1 md:max-h-none md:aspect-auto" : "max-h-[70vh] rounded-lg",
        )}
        // the clip's picture under the video, the same size as its frames: what shows until the first frame is there
        style={{ ...shape, ...(picture ? { backgroundImage: `url("${picture}")` } : {}) }}
      >
        {a.kind === "audio" ? (
          <audio key={src} ref={media} src={src} controls preload="auto" className="absolute inset-x-4 bottom-4 w-[calc(100%-2rem)]" {...events} />
        ) : (
          <video
            key={src}
            ref={media}
            src={src}
            poster={picture}
            controls={phase !== "failed"}
            playsInline
            preload="auto"
            className={phase === "failed" ? "hidden" : "absolute inset-0 h-full w-full object-contain"}
            {...events}
          />
        )}
        {phase === "loading" && !note && a.kind === "video" && (
          <Loader2 aria-label="Loading" className="pointer-events-none absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/80 drop-shadow" />
        )}
        {note && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/65 p-6 text-center text-white">
            <Note note={note} file={original(a, detail)} />
          </div>
        )}
        {muted && phase !== "failed" && (
          <Button
            size="sm"
            className="absolute left-2 top-2 bg-black/70 text-white hover:bg-black/80"
            onClick={() => {
              const v = media.current;
              if (!v) return;
              v.muted = false;
              setMuted(false);
              if (v.paused) void v.play().catch(() => {});
            }}
          >
            <Volume2 className="h-4 w-4" />
            Sound on
          </Button>
        )}
        {onPrev && (
          <button type="button" aria-label="Previous clip" onClick={onPrev} className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70">
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        {onNext && (
          <button type="button" aria-label="Next clip" onClick={onNext} className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70">
            <ChevronRight className="h-5 w-5" />
          </button>
        )}
      </div>
    {strip && <Filmstrip {...strip} now={now} media={media} />}
    </div>
  );
}

/** Frames the filmstrip shows across: every other frame of the strip, so each is big enough to make out. */
const CELLS = 10;

/**
 * The clip's strip of frames under its player. A mouse over it shows the frame there and its time, a thin line marks
 * where the clip is playing, and a click or a drag goes there. The player's own controls do the same from the keyboard.
 */
function Filmstrip({ url, duration, now, media }: { url: string; duration: number; now: number; media: RefObject<HTMLVideoElement | null> }) {
  const [hover, setHover] = useState<number | null>(null);
  const seek = (frac: number) => {
    const v = media.current;
    if (v) v.currentTime = frac * duration;
  };
  return (
    <div
      aria-hidden
      data-filmstrip
      className="relative flex w-full shrink-0 cursor-pointer touch-none select-none bg-black"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seek(across(e));
      }}
      onPointerMove={(e) => {
        const at = across(e);
        if (e.pointerType === "mouse") setHover(at);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(at);
      }}
      onPointerLeave={() => setHover(null)}
    >
      {Array.from({ length: CELLS }, (_, i) => (
        <div key={i} className="aspect-video min-w-0 flex-1" style={frameStyle(url, Math.floor(((i + 0.5) * SPRITE_FRAMES) / CELLS))} />
      ))}
      <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white" style={{ left: `${Math.min(1, now / duration) * 100}%` }} />
      {hover !== null && (
        <div
          data-frame
          className="pointer-events-none absolute bottom-full mb-1.5 flex -translate-x-1/2 flex-col items-center gap-1"
          // kept inside the strip's width, so it never hangs over the window's edge
          style={{ left: `clamp(80px, ${hover * 100}%, calc(100% - 80px))` }}
        >
          <div className="h-[90px] w-[160px] rounded shadow-lg ring-1 ring-white/30" style={frameStyle(url, frameAt(hover))} />
          <span className="rounded bg-black/75 px-1.5 py-0.5 font-mono text-[11px] text-white">{clock(hover * duration)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * A photo in the clip window: its original at full quality (its small picture under it until that is there, and in its
 * place where the window can't show the file). A click shows it on the whole screen; Escape or a click closes that.
 */
export function ClipImage({ asset: a, fill }: { asset: AssetCard; fill: boolean }) {
  const [big, setBig] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const src = failed ? a.thumbUrl : `/api/library/media/${a.versionId}/source`;
  if (!src) return null;
  return (
    <>
      <button
        type="button"
        aria-label="Show on the whole screen"
        onClick={() => setBig(true)}
        style={!loaded && a.thumbUrl ? { backgroundImage: `url("${a.thumbUrl}")` } : undefined}
        className={cn("cursor-zoom-in bg-contain bg-center bg-no-repeat", fill ? "h-full max-h-[45dvh] w-full md:max-h-none" : "w-full")}
      >
        <img
          src={src}
          alt={a.title}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={fill ? "h-full w-full object-contain" : "w-full rounded-lg"}
        />
      </button>
      <Dialog open={big} onOpenChange={setBig}>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          onClick={() => setBig(false)}
          className="flex h-dvh w-screen max-w-none cursor-zoom-out items-center justify-center rounded-none border-0 bg-black p-0 sm:max-w-none"
        >
          <DialogTitle className="sr-only">{a.title}</DialogTitle>
          <img src={src} alt={a.title} className="max-h-full max-w-full object-contain" />
        </DialogContent>
      </Dialog>
    </>
  );
}

function Note({ note, file }: { note: PlayerNote; file: { href: string; name: string } }) {
  if (note === "unknown") return <Loader2 aria-label="Loading" className="h-6 w-6 animate-spin" />;
  if (note === "preparing")
    return (
      <div className="flex flex-col items-center gap-1.5">
        <Loader2 className="h-5 w-5 animate-spin" />
        <p className="text-sm font-medium">Making a proxy</p>
        <p className="text-xs text-white/70">It starts playing when it's ready.</p>
      </div>
    );
  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-sm">This file doesn't play here.</p>
      <Button size="sm" variant="secondary" asChild>
        <a href={file.href} download={file.name}>
          <Download className="h-4 w-4" />
          Download
        </a>
      </Button>
    </div>
  );
}
