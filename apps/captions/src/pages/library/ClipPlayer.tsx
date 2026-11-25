import { createPortal } from "react-dom";
import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ChevronLeft, ChevronRight, Download, Loader2, Volume2 } from "lucide-react";
import { hostsOriginals, hostsProxies, type AssetCard, type AssetDetail, type LibraryUpload } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { awayLine, pickSource, proxySource, useHere, type Source } from "@/lib/here";
import { listLibraries } from "@/lib/library";
import { askMediaFolder } from "@/lib/local-files";
import { macPlaces, placesConnect } from "@/lib/thisMac";
import { placeLine } from "@/lib/wording";
import { cn } from "@/lib/utils";
import { copyReady, original, playerNote, type PlayerNote } from "./clip";

// the player's skin is its own chunk, loaded when a clip opens (SkinPlayer.tsx)
const SkinPlayer = lazy(() => import("./SkinPlayer"));

/**
 * The clip's player, at the top of its panel. It starts playing as it opens: with sound where the window allows that,
 * else muted with a Sound on button. The clip's picture shows under it until the first frame is there. A file this
 * window cannot decode says so in the player's place; while its lighter copy is being made the panel's detail says so
 * (read again on each library change), and the player starts once the copy is there: the same play address then
 * serves the copy. A video plays in Video.js's skin (SkinPlayer): its bar previews the clip's strip on hover.
 * A clip with its own turn (a screen recorded on its side) is turned here, the file never is. A bar would turn with it,
 * so it is a plain video with none: a click plays or pauses.
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
  file,
  actions,
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
  /** "proxy": the clip's proxy plays although its original is here (the clip panel's File row) */
  file?: "proxy";
  /** where the Allow folder and Connect buttons go: the side panel, under where the clip is (never on the player) */
  actions?: HTMLElement | null;
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
  const pick = file === "proxy" ? proxySource : pickSource;
  useEffect(() => void (places && here && !pin && setPin(pick(check, a.versionId, serverPlays))), [places, here, pin, pick, check, a.versionId, serverPlays]);
  const onServer = !places || !!pin?.src.startsWith("/api/");
  // the original asked for again (`tries`, a new address so the window does not answer from the failed one)
  const [tries, setTries] = useState(0);
  const local = pin && !onServer ? (tries ? `${pin.src}${pin.src.includes("?") ? "&" : "?"}try=${tries}` : pin.src) : "";
  const base = !places ? server : !pin ? "" : onServer ? server : local;
  const start = pin?.at ?? startAt;
  const src = base && `${base}${start ? `#t=${start}` : ""}`;
  // what the element at `src` last said; a new address starts as loading
  const [seen, setSeen] = useState<{ src: string; phase: Phase }>({ src: "", phase: "loading" });
  const phase = seen.src === src ? seen.phase : "loading";
  const to = (p: Phase) => setSeen({ src, phase: p });
  // the element playing now: the skin's arrives a moment later (its chunk), and it starts playing once it is there
  const [el, setEl] = useState<HTMLVideoElement | HTMLAudioElement | null>(null);
  const bind = (v: HTMLVideoElement | HTMLAudioElement | null) => {
    (media as { current: unknown }).current = v;
    setEl(v);
  };

  // another source takes over at the second playing now
  const take = (s: Source) => void (s.src !== pin?.src && setPin({ ...s, at: media.current?.currentTime }));
  // what plays stopped answering (the share or the internet went): the proxy, the cached one first, at the same second,
  // and this computer asked again. False when that is what plays already
  const fallback = proxySource(check, a.versionId, serverPlays);
  // no proxy anywhere (none cached here, and the server plays nothing of this library): the original is all there is, so
  // it is never left for nothing. A network share that was asleep answers late: this computer is asked again and the
  // original tried again, a little later each time; after the last try it says so, with Retry
  const nowhere = !fallback.src;
  const retryLater = useRef(0);
  useEffect(() => () => clearTimeout(retryLater.current), []);
  const leave = () => {
    if (!pin || pin.src === fallback.src) return false;
    if (nowhere) {
      if (pin.badge !== "Original" || tries >= ORIGINAL_TRIES) return false;
      clearTimeout(retryLater.current);
      retryLater.current = window.setTimeout(() => void again().then(() => setTries((n) => n + 1)), 1500 * (tries + 1));
      return true;
    }
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
    const v = el;
    if (!v || !src) return;
    v.play().catch((e: unknown) => {
      // a file it cannot play says so through `error`; an abort is the panel moving on
      if ((e as DOMException)?.name !== "NotAllowedError") return;
      v.muted = true;
      setMuted(true);
      void v.play().catch(() => {});
    });
  }, [src, el]);

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
  // the original here didn't open after its tries, and there is nothing else to play: said, with Retry
  const stuck = phase === "failed" && pin?.badge === "Original" && nowhere;
  const note = stuck || said === "missing" || away ? null : said;
  // the owner, with no proxies and no originals hosted: told why it plays only where the files are
  const noUpload = !!upload?.owner && !hostsProxies(upload.upload) && !hostsOriginals(upload.upload);
  const awayNote = stuck ? <Stuck onTry={() => void again().then(() => setTries((n) => n + 1))} /> : away && <Away line={away} noUpload={noUpload} />;

  // the original is here in a folder the page may not play from yet, or on a share that needs its login: one button
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const press = (run: () => Promise<string | null>) => async () => {
    setBusy(true);
    setProblem("");
    try {
      const failed = await run();
      if (failed) return setProblem(failed);
      take(pick((await again())[a.versionId], a.versionId));
    } finally {
      setBusy(false);
    }
  };
  const access = check?.state === "here" && check.needs === "access" ? check : null;
  const share = check?.state === "away" && check.needs === "connect" ? check.root : undefined;
  // in the side panel by where the clip is, never over the picture (owner, 2026-11-23)
  const buttons = (access || share) && (
    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
      {access && (
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={busy}
          title={`Allow access to ${access.root?.name ?? access.folder.split("/").filter(Boolean).pop() ?? access.folder}`}
          onClick={press(() => askMediaFolder(access.folder).then(() => null))}
        >
          Allow folder
        </Button>
      )}
      {share && (
        <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={press(() => placesConnect(share.key).then((r) => ("ok" in r ? null : `Could not connect ${share.name}`), () => `Could not connect ${share.name}`))}>
          Connect
        </Button>
      )}
      {problem && <span>{problem}</span>}
    </div>
  );
  const placed = buttons && actions ? createPortal(buttons, actions) : null;
  const badge = places && pin && phase !== "failed" && (
    <span
      title={pin.badge === "Proxy" ? (awayLine(check) ?? undefined) : undefined}
      className="rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white"
    >
      {pin.badge === "Original" && detail?.versions?.find((v) => v.id === a.versionId)?.blurred ? "Blurred" : pin.badge}
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
      if (places && pin) take(pick(check, a.versionId));
    },
    onPause: () => {
      clearTimeout(stall.current);
      pausedOn.current = src;
      to("paused");
    },
    onWaiting: () => {
      to("loading");
      clearTimeout(stall.current);
      // a slow original with nothing else to play keeps loading: a stall is waited out, never left
      if (pin && pin.src !== fallback.src && !nowhere) stall.current = window.setTimeout(leave, 3000);
    },
    onCanPlay: () => clearTimeout(stall.current),
    onError: () => {
      if (leave()) return;
      if (!retry) setPlainFailed(true);
      to("failed");
    },
    onVolumeChange: () => setMuted(!!media.current?.muted),
    onTimeUpdate: () => onTime?.(media.current?.currentTime ?? 0),
  };

  // an address that fails while the player is still going on the page (its chunk, its parts) errors before anyone
  // listens: said once the element is there, so the proxy or the note follows as for any error
  useEffect(() => {
    if (el?.error) events.onError();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per element
  }, [el]);

  if (a.kind === "audio" && !fill) {
    return (
      <>
        <audio key={src} ref={bind} src={src || undefined} controls preload="auto" className="w-full" {...events} />
        {note && <Note note={note} file={original(a, detail)} />}
        {awayNote}
        {placed}
      </>
    );
  }

  // the box has the clip's own shape (an upright clip stands upright), at most so tall; in the window it fills its side
  const shape = { "--ar": a.width && a.height ? `${a.width} / ${a.height}` : "16 / 9" } as CSSProperties;
  return (
    <div className={cn("flex w-full flex-col", fill ? "md:h-full" : "gap-1.5")}>
      <div
        // the page's ← → and Space stay out of the player: there they are the player's own keys (ClipPanel)
        data-player
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
          <audio key={src} ref={bind} src={src || undefined} controls preload="auto" className="absolute inset-x-4 bottom-4 w-[calc(100%-2rem)]" {...events} />
        ) : turn ? (
          <video
            key={src}
            ref={bind}
            src={src || undefined}
            playsInline
            preload="auto"
            className={phase === "failed" ? "hidden" : "absolute left-1/2 top-1/2 cursor-pointer object-contain"}
            // turned about its middle; on its side it is laid out as tall as the box is wide, so it fills the box once turned
            style={{ width: side ? "100cqh" : "100%", height: side ? "100cqw" : "100%", transform: `translate(-50%, -50%) rotate(${turn}deg)` }}
            onClick={(e) => void (e.currentTarget.paused ? e.currentTarget.play().catch(() => {}) : e.currentTarget.pause())}
            {...events}
          />
        ) : (
          <Suspense fallback={null}>
            <SkinPlayer
              key={src}
              media={bind}
              src={src || undefined}
              poster={picture}
              // the clip's strip as preview frames over the bar (api/library thumbs.vtt)
              thumbs={a.spriteUrl ? `/api/library/media/${a.versionId}/thumbs.vtt` : undefined}
              className={phase === "failed" ? "hidden" : "absolute inset-0 h-full w-full"}
              {...events}
            />
          </Suspense>
        )}
        {/* a turned clip has no bar, so no bar's spinner: its own while it loads */}
        {phase === "loading" && turn && !note && (
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
          <button type="button" aria-label="Previous clip" onClick={(e) => (e.stopPropagation(), onPrev())} className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70">
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        {onNext && (
          <button type="button" aria-label="Next clip" onClick={(e) => (e.stopPropagation(), onNext())} className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70">
            <ChevronRight className="h-5 w-5" />
          </button>
        )}
      </div>
      {placed}
    </div>
  );
}

/** How often an original on this computer is tried again before the player says it didn't open (with no proxy to play). */
const ORIGINAL_TRIES = 3;

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

/** The original on this computer didn't open, after its tries (a share that didn't answer): one line and Retry. */
function Stuck({ onTry }: { onTry: () => void }) {
  return (
    <div className="flex max-w-sm flex-col items-center gap-2 text-sm">
      <p>The original on this computer didn't open.</p>
      <Button size="sm" variant="secondary" onClick={onTry}>
        Retry
      </Button>
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
