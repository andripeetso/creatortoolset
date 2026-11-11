import { useEffect, useState, type RefObject } from "react";
import { ChevronLeft, ChevronRight, Download, Loader2, Volume2 } from "lucide-react";
import type { AssetCard, AssetDetail } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { copyReady, original, playerNote, type PlayerNote } from "./clip";

/**
 * The clip's player, at the top of its panel. It starts playing as it opens: with sound where the window allows that,
 * else muted with a Sound on button. The clip's picture shows under it until the first frame is there. A file this
 * window cannot decode says so in the player's place; while its lighter copy is being made the panel's detail says so
 * (read again on each library change), and the player starts once the copy is there: the same play address then
 * serves the copy.
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
}: {
  asset: AssetCard;
  detail: AssetDetail | null;
  media: RefObject<(HTMLVideoElement & HTMLAudioElement) | null>;
  startAt: number;
  onPrev?: () => void;
  onNext?: () => void;
  /** the second playing now, for the transcript's mark */
  onTime?: (s: number) => void;
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
    onTimeUpdate: () => onTime?.(media.current?.currentTime ?? 0),
  };

  if (a.kind === "audio") {
    return (
      <>
        <audio key={src} ref={media} src={src} controls preload="auto" className="w-full" {...events} />
        {note && <Note note={note} file={original(a, detail)} />}
      </>
    );
  }

  return (
    <div
      className="relative aspect-video w-full overflow-hidden rounded-lg bg-black bg-contain bg-center bg-no-repeat"
      // the clip's picture under the video, the same size as its frames: what shows until the first frame is there
      style={picture ? { backgroundImage: `url("${picture}")` } : undefined}
    >
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
      {phase === "loading" && !note && (
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
        <button type="button" aria-label="Previous clip" onClick={onPrev} className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70">
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}
      {onNext && (
        <button type="button" aria-label="Next clip" onClick={onNext} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70">
          <ChevronRight className="h-5 w-5" />
        </button>
      )}
    </div>
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
