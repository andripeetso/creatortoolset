import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ChevronLeft, ChevronRight, Download, Loader2, Volume2 } from "lucide-react";
import { hostsOriginals, hostsProxies, SPRITE_FRAMES, type AssetCard, type AssetDetail, type LibraryUpload } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { awayLine, pickSource, proxySource, useHere, type Source } from "@/lib/here";
import { listLibraries } from "@/lib/library";
import { askMediaFolder } from "@/lib/local-files";
import { macPlaces, placesConnect } from "@/lib/thisMac";
import { placeLine } from "@/lib/wording";
import { cn } from "@/lib/utils";
import { across, clock, frameAt, frameStyle } from "./ClipCards";
import { copyReady, original, playerNote, type PlayerNote } from "./clip";

/**
 * The clip's player, at the top of its panel. It starts playing as it opens: with sound where the window allows that,
 * else muted with a Sound on button. The clip's picture shows under it until the first frame is there. A file this
 * window cannot decode says so in the player's place; while its lighter copy is being made the panel's detail says so
 * (read again on each library change), and the player starts once the copy is there: the same play address then
 * serves the copy. Under a video, its strip of frames (Filmstrip).
 * A clip with its own turn (a screen recorded on its side) is turned here, the file never is. The window's own controls
 * would turn with it, so it has none: a click plays or pauses, and the strip under it goes to a moment.
 * ponytail: no volume or full screen on a turned clip; its own controls if he asks for them
 * In a Mac app that checks where originals are (lib/here.ts), a clip whose original is on a computer plays it from this
 * one when it is here (badge Original), else a proxy (badge Proxy): this computer's cached one (Available offline) before
 * the server's. A clip kept offline asks too, so it plays without internet. What plays is chosen once the answer is in,
 * and kept: the original going away (an error, 3 s stalled, or the next answer while it plays) takes the proxy at the
 * same second and keeps playing, as does the server's proxy failing when the cache has the clip; an original coming back
 * is taken at the next play after a pause, or at once after a button here.
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
  serverPlays = true,
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
  /** false when the server plays nothing of this clip (Upload none, not shared with members): a copy only this computer has plays */
  serverPlays?: boolean;
}) {
  const [muted, setMuted] = useState(false);
  // the plain address failed: once the lighter copy is made it is asked for again, at a new address (`?r=1`) so the
  // window does not answer from what it kept of the failed one
  const [plainFailed, setPlainFailed] = useState(false);
  const retry = plainFailed && copyReady(detail);
  // no server address where the server plays nothing: a clip this computer lacks then has no src (never a 409 request)
  const server = serverPlays ? `/api/library/media/${a.versionId}/play${retry ? "?r=1" : ""}` : "";
  // every clip asks this computer, not only the ones the server's card flags: a folder or place row here may hold it (decision 5)
  const places = macPlaces();
  const [here, again] = useHere(places ? a.libraryId : null, [a.versionId]);
  const check = here?.[a.versionId];
  // what plays, once this computer has answered; `at` the second it starts at when it took over from another
  const [pin, setPin] = useState<Source & { at?: number }>();
  useEffect(() => void (places && here && !pin && setPin(pickSource(check, a.versionId, serverPlays))), [places, here, pin, check, a.versionId, serverPlays]);
  const onServer = !places || !!pin?.src.startsWith("/api/");
  const base = !places ? server : !pin ? "" : onServer ? server : pin.src;
  const start = pin?.at ?? startAt;
  const src = base && `${base}${start ? `#t=${start}` : ""}`;
  // what the element at `src` last said; a new address starts as loading
  const [seen, setSeen] = useState<{ src: string; phase: Phase }>({ src: "", phase: "loading" });
  const phase = seen.src === src ? seen.phase : "loading";
  const to = (p: Phase) => setSeen({ src, phase: p });
  const [now, setNow] = useState(startAt);
  // a jump (the strip, the player's bar, a line in the transcript) is fetching its moment: the spinner shows and the
  // strip's line pulses there. `waiting` alone misses it: a paused clip, and WebKit often, only say `seeking`
  const [seekingAt, setSeekingAt] = useState("");
  const seeking = seekingAt === src;
  // what of the file the window has fetched, as parts of its length, drawn along the strip's foot
  const [fetched, setFetched] = useState<[number, number][]>([]);

  // another source takes over at the second playing now
  const take = (s: Source) => void (s.src !== pin?.src && setPin({ ...s, at: media.current?.currentTime }));
  // what plays stopped answering (the share or the internet went): the proxy, the cached one first, at the same second,
  // and this computer asked again. False when that is what plays already
  const fallback = proxySource(check, a.versionId, serverPlays);
  const leave = () => {
    if (!pin || pin.src === fallback.src) return false;
    take(fallback);
    void again();
    return true;
  };
  const stall = useRef(0);
  useEffect(() => () => clearTimeout(stall.current), [src]);
  // a pause on this source: the next play takes what this computer says now
  const pausedOn = useRef("");
  useEffect(() => {
    const v = media.current;
    if (pin?.badge === "Original" && check && !(check.state === "here" && check.url) && v && !v.paused) leave();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on a new answer only
  }, [check]);

  useEffect(() => {
    const v = media.current;
    if (!v || !src) return;
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
  // nothing plays here: the original isn't on this computer and the server has no proxy of it
  // nothing plays here: say where the clip is (this computer's answer, else the server's place row); the server refused its copy
  // the server plays nothing of it: say where it is (inside or outside the Mac app), once this computer has answered
  const waiting = !!places && !here;
  // (also without the Mac app: a browser that the server refuses says it too)
  // the library's Hosted media, read once it is needed: under Originals the server plays an original, so a file it cannot
  // play is "Can't play this format here" with Download, not a place to go to
  // undefined: still asking; null: the library could not be read (the player then says what it said before)
  const [upload, setUpload] = useState<{ upload: LibraryUpload; owner: boolean } | null>();
  useEffect(() => {
    if (phase !== "failed" && serverPlays) return;
    let gone = false;
    listLibraries().then(
      (ls) => {
        const l = ls.find((x) => x.id === a.libraryId);
        if (!gone) setUpload(l ? { upload: l.settings.upload, owner: !l.readOnly } : null);
      },
      () => !gone && setUpload(null),
    );
    return () => {
      gone = true;
    };
  }, [phase, serverPlays, a.libraryId]);
  const serverOriginals = !!upload && hostsOriginals(upload.upload);
  // the library's answer first: while it is pending, a failed server play says nothing rather than the wrong line
  const failedOnServer = phase === "failed" && onServer && upload !== undefined && !serverOriginals;
  // proxies hosted, none of this clip: the server holds no copy of it to play (SCREENS-COPY §3)
  const noCopy = failedOnServer && !!upload && hostsProxies(upload.upload) ? "This clip isn't on the server." : null;
  const away =
    !waiting && (failedOnServer || (!serverPlays && !src)) ? (awayLine(check) ?? noCopy ?? placeLine(a.placeWord ?? { word: "unchecked" })) : null;
  const note = said === "missing" || away ? null : said;
  // the owner, with no proxies and no originals hosted: told why it plays only where the files are
  const noUpload = !!upload?.owner && !hostsProxies(upload.upload) && !hostsOriginals(upload.upload);
  const awayNote = away && <Away line={away} noUpload={noUpload} />;

  // the original is here in a folder the page may not play from yet, or on a share that needs its login: one button
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const press = (run: () => Promise<string | null>) => async () => {
    setBusy(true);
    setProblem("");
    try {
      const failed = await run();
      if (failed) return setProblem(failed);
      take(pickSource((await again())[a.versionId], a.versionId));
    } finally {
      setBusy(false);
    }
  };
  const access = check?.state === "here" && check.needs === "access" ? check : null;
  const share = check?.state === "away" && check.needs === "connect" ? check.root : undefined;
  const buttons = (access || share) && (
    <div className="flex flex-wrap items-center gap-2 py-1.5 text-xs text-zinc-400">
      {access && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={press(() => askMediaFolder(access.folder).then(() => null))}>
          Allow access to {access.root?.name ?? access.folder.split("/").filter(Boolean).pop() ?? access.folder}
        </Button>
      )}
      {share && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={press(() => placesConnect(share.key).then((r) => ("ok" in r ? null : `Could not connect ${share.name}`), () => `Could not connect ${share.name}`))}>
          Connect
        </Button>
      )}
      {problem && <span>{problem}</span>}
    </div>
  );
  const badge = places && pin && phase !== "failed" && (
    <span
      title={pin.badge === "Proxy" ? (awayLine(check) ?? undefined) : undefined}
      className="rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white"
    >
      {pin.badge}
    </span>
  );
  const picture = a.thumbUrl;
  const turn = a.kind === "video" ? a.turn : undefined;
  const side = turn === 90 || turn === 270;

  const events = {
    onPlaying: () => {
      clearTimeout(stall.current);
      to("playing");
    },
    onPlay: () => {
      if (pausedOn.current !== src) return;
      pausedOn.current = "";
      if (places && pin) take(pickSource(check, a.versionId));
    },
    onPause: () => {
      clearTimeout(stall.current);
      pausedOn.current = src;
      to("paused");
    },
    onWaiting: () => {
      to("loading");
      clearTimeout(stall.current);
      if (pin && pin.src !== fallback.src) stall.current = window.setTimeout(leave, 3000);
    },
    onCanPlay: () => clearTimeout(stall.current),
    onSeeking: () => setSeekingAt(src),
    onSeeked: () => setSeekingAt(""),
    onProgress: () => {
      const v = media.current;
      if (!v || !v.duration) return;
      const b = v.buffered;
      setFetched(Array.from({ length: b.length }, (_, i) => [b.start(i) / v.duration, b.end(i) / v.duration]));
    },
    onError: () => {
      if (leave()) return;
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
        <audio key={src} ref={media} src={src || undefined} controls preload="auto" className="w-full" {...events} />
        {note && <Note note={note} file={original(a, detail)} />}
        {awayNote}
        {buttons}
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
          turn && "[container-type:size]",
          a.kind === "audio" ? "h-40 md:h-auto" : "aspect-[var(--ar)]",
          fill ? "max-h-[45dvh] md:min-h-0 md:flex-1 md:max-h-none md:aspect-auto" : "max-h-[70vh] rounded-lg",
        )}
        // the clip's picture under the video, the same size as its frames: what shows until the first frame is there
        style={{ ...shape, ...(picture ? { backgroundImage: `url("${picture}")` } : {}) }}
      >
        {a.kind === "audio" ? (
          <audio key={src} ref={media} src={src || undefined} controls preload="auto" className="absolute inset-x-4 bottom-4 w-[calc(100%-2rem)]" {...events} />
        ) : (
          <video
            key={src}
            ref={media}
            src={src || undefined}
            // the picture is upright already: on a turned video it would be turned twice
            poster={turn ? undefined : picture}
            controls={phase !== "failed" && !turn}
            playsInline
            preload="auto"
            className={phase === "failed" ? "hidden" : turn ? "absolute left-1/2 top-1/2 cursor-pointer object-contain" : "absolute inset-0 h-full w-full object-contain"}
            // turned about its middle; on its side it is laid out as tall as the box is wide, so it fills the box once turned
            style={turn ? { width: side ? "100cqh" : "100%", height: side ? "100cqw" : "100%", transform: `translate(-50%, -50%) rotate(${turn}deg)` } : undefined}
            onClick={turn ? (e) => void (e.currentTarget.paused ? e.currentTarget.play().catch(() => {}) : e.currentTarget.pause()) : undefined}
            {...events}
          />
        )}
        {(phase === "loading" || (seeking && phase !== "failed")) && !note && a.kind === "video" && (
          // centred by its box: animate-spin's rotate replaces a translate on the icon itself, which threw it off centre
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Loader2 aria-label="Loading" className="h-6 w-6 animate-spin text-white/80 drop-shadow" />
          </div>
        )}
        {(note || awayNote) && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/65 p-6 text-center text-white">
            {note ? <Note note={note} file={original(a, detail)} /> : awayNote}
          </div>
        )}
        {/* the badge first: it is there before Sound on, which then never moves */}
        <div className="absolute left-2 top-2 flex items-center gap-2">
          {badge}
          {muted && phase !== "failed" && (
            <Button
              size="sm"
              className="bg-black/70 text-white hover:bg-black/80"
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
        </div>
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
      {strip && <Filmstrip {...strip} now={now} media={media} seeking={seeking} fetched={fetched} />}
      {buttons && <div className="shrink-0 px-2">{buttons}</div>}
    </div>
  );
}

/** Frames the filmstrip shows across: every other frame of the strip, so each is big enough to make out. */
const CELLS = 10;

/**
 * The clip's strip of frames under its player. A mouse over it shows the frame there and its time, a thin line marks
 * where the clip is playing, and a click or a drag goes there: the line moves at once and pulses until the moment is
 * fetched (the player's spinner shows meanwhile). A light bar along its foot shows what of the file is fetched. The player's own controls do the same from the keyboard.
 */
function Filmstrip({
  url,
  duration,
  now,
  media,
  seeking,
  fetched,
}: {
  url: string;
  duration: number;
  now: number;
  media: RefObject<HTMLVideoElement | null>;
  seeking: boolean;
  fetched: [number, number][];
}) {
  // the line goes where he clicked at once, not where the player still is
  const [target, setTarget] = useState<number | null>(null);
  useEffect(() => void (!seeking && setTarget(null)), [seeking]);
  const [hover, setHover] = useState<number | null>(null);
  const seek = (frac: number) => {
    const v = media.current;
    if (!v) return;
    v.currentTime = frac * duration;
    setTarget(frac);
  };
  const at = target ?? Math.min(1, now / duration);
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
      {fetched.map(([a, b]) => (
        <div key={a} className="pointer-events-none absolute bottom-0 h-1 bg-white/60" style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }} />
      ))}
      <div
        className={cn("pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white", seeking && "w-1 animate-pulse")}
        style={{ left: `${at * 100}%` }}
      />
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

/** Nothing plays here: where the original is, and for the owner why there is no proxy to play instead. */
function Away({ line, noUpload }: { line: string; noUpload: boolean }) {
  return (
    <div className="flex max-w-sm flex-col items-center gap-1.5 text-sm">
      <p>{line}</p>
      {noUpload && <p className="text-xs opacity-70">Proxies aren't uploaded for this library, so it plays only where the originals are.</p>}
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
      </div>
    );
  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-sm">Can't play this format here</p>
      <Button size="sm" variant="secondary" asChild>
        <a href={file.href} download={file.name}>
          <Download className="h-4 w-4" />
          Download
        </a>
      </Button>
    </div>
  );
}
