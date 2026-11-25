import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronDown } from "lucide-react";
import { failedWords, NEEDS, waitingLine, type AssetCard, type LibraryProgress, type LibraryStage, type LibraryStepEstimate, type WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { getProgress, getWatch, stopLibrary } from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { cn } from "@/lib/utils";
import { ownMacLine } from "@/lib/wording";
import { hasThisMac, useThisMac } from "@/components/settings/ThisMacSection";

/**
 * The Media Library's processing, said in time and money: a line per step with the time left while clips are being
 * prepared (api/library/estimate.ts), read at this server's own pace. Nothing asks before files or a folder go in (11-19):
 * the import's one line and a folder's indexing line say the total, and the monthly budget guards the cost.
 */

export function aboutTime(s: number): string {
  if (s < 60) return "under a minute";
  const m = Math.round(s / 60);
  if (m < 60) return `about ${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `about ${h} h${rest ? ` ${rest} min` : ""}`;
}


export function aboutUsd(usd: number): string {
  if (usd < 0.01) return "under a cent";
  return `about $${usd < 10 ? usd.toFixed(2) : Math.round(usd).toLocaleString()}`;
}

/** One line per step that runs or waits; a step switched off says nothing. `proxies`: the library makes them (its settings). */
export function stepLine(s: LibraryStepEstimate, proxies = true): ReactNode {
  if (s.route === "off") return null;
  const what = { files: proxies ? "Pictures and proxies" : "Pictures", transcript: "Transcripts", describe: "Descriptions", look: "Shot descriptions", embed: "Search by meaning" }[s.step];
  if (s.route === "none") return s.step === "embed" ? null : <Needs step={s.step} what={what} />;
  const on = {
    server: "on this server, free",
    device: "on this computer, free",
    computer: "on your own computer, free",
    deepgram: `on the Deepgram key, ${aboutUsd(s.usd)}`,
    openai: `on the OpenAI key, ${aboutUsd(s.usd)}`,
    api: `on the Anthropic key, ${aboutUsd(s.usd)}`,
    budget: `on the team budget, ${aboutUsd(s.usd)}`,
    provider: `on the AI provider, ${aboutUsd(s.usd)} of usage at API prices, counted toward the plan's limits`,
  }[s.route];
  return `${what} ${on}`;
}

/** A folder's own name, the way the person knows it ("/Volumes/Card/Trip" → "Trip"). */
export const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Each step of preparing, in the words of the person who watches it go by (api/library/estimate.ts STAGES). */
const STAGE_NAME: Record<LibraryStage["kind"], string> = {
  blur: "Face Blur",
  thumb: "Pictures",
  proxy: "Proxies",
  fingerprint: "Duplicate checks",
  transcribe: "Transcripts",
  describe: "Descriptions",
  look: "Shot descriptions",
  timeline: "Video breakdown",
  embed: "Search by meaning",
};

/** One line of the list: what, how far (a thin bar), how many; the step running now shows its clip and a soft pulse. */
function StageRow({ name, done, of, now, busy = !!now, failed = 0 }: { name: string; done: number; of: number; now?: string; busy?: boolean; failed?: number }) {
  const through = done + failed >= of;
  return (
    <li className="col-span-3 grid grid-cols-subgrid items-center text-sm">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", busy ? "bg-zinc-400 motion-safe:animate-pulse dark:bg-zinc-300" : "bg-transparent")} />
        <span className={cn("truncate", through && "text-zinc-500")}>
          {name}
          {now && <span className="text-zinc-500"> · {now}</span>}
        </span>
      </span>
      <Progress value={(Math.min(of, done + failed) / Math.max(1, of)) * 100} className={cn("h-1", through && "opacity-50")} />
      <span className="shrink-0 text-right text-xs tabular-nums text-zinc-500">
        {done.toLocaleString()} of {of.toLocaleString()}
        {failed > 0 && ` · ${failed.toLocaleString()} failed`}
      </span>
    </li>
  );
}

/** What a step waiting for the person needs, in a few words, with the page that gives it one click away. */
function Needs({ step, what, count = 0, away, reason, href }: { step: LibraryStepEstimate["step"]; what?: string; count?: number; away?: boolean; reason?: string; href?: string }) {
  // the estimate names the step ("AI descriptions need an AI"), the progress line counts its clips
  const line = waitingLine({ step, count, away, reason, href });
  const text = what ? `${what} need ${NEEDS[step].needs}` : line.text;
  return (
    <Link to={what ? NEEDS[step].href : line.href} className="underline-offset-4 hover:underline">
      {text}
    </Link>
  );
}

/**
 * A thin bar that moves the whole time work runs, also while no count changes: its fill is how far (`value`, 0 to 1,
 * when known), and a light passes along it. With reduced motion the light stays and breathes instead of travelling.
 */
export function MovingBar({ value, className }: { value?: number; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === undefined ? undefined : Math.round(value * 100)}
      className={cn("relative h-1 w-full overflow-hidden rounded-full bg-zinc-500/20", className)}
    >
      {value !== undefined && (
        <div className="absolute inset-y-0 left-0 rounded-full bg-zinc-500 transition-[width] duration-700 dark:bg-zinc-400" style={{ width: `${Math.min(100, Math.max(3, value * 100))}%` }} />
      )}
      <div className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-zinc-400/70 to-transparent motion-safe:animate-[processing-progress-shimmer_1.6s_ease-in-out_infinite] motion-reduce:left-1/3 motion-reduce:animate-pulse dark:via-white/50" />
    </div>
  );
}

const OPEN_KEY = "library-processing-open";
const remembered = () => {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * While a library has work left: one line, "Preparing 10 clips · about 1 min left", over a bar that keeps moving, and
 * the folder's clips still to come among them. Opened (the person's choice is remembered), one line per step in the
 * order they run (pictures, proxies, duplicate checks, transcripts, descriptions), each counting up, and what waits.
 * When nothing runs, what waits for a key, an AI or the plan's limit is said by itself: it is why nothing moves.
 */
type Waiting = LibraryProgress["waiting"][number];
/** What only the person can change: a key or an AI provider, or (their own) a computer setting no computer can get past. */
const needsYou = (w: Waiting) => (!w.limit && !w.computer && !w.away && !w.wait) || (w.wait === "needs" && !!w.mine);

/**
 * The library page leaves out what a computer will take or what the person can't change there, and says what needs them
 * and work no computer has taken. What waits for a computer, kind by kind, is in the Status view (pages/library/settings/Made.tsx).
 */
export function LibraryProgressBar({ libraryId }: { libraryId: string }) {
  const progress = useCachedLoad<LibraryProgress>(`/api/library/${libraryId}/progress`, () => getProgress(libraryId));
  const p = progress.data;
  const [stopping, setStopping] = useState<"busy" | "failed" | null>(null);
  // in the Mac app, this Mac's own switch: asked only while a wait names its computers as offline
  const bridge = useThisMac(hasThisMac() && !!p?.waiting.some((w) => w.wait === "offline" && w.devices?.length));
  // the same saved status as the folder card and the watch list; only the owner gets one
  const watch = useCachedLoad<WatchStatus>(`/api/library/${libraryId}/watch`, () => getWatch(libraryId)).data;
  const [open, setOpen] = useState(remembered);
  const adding = (watch?.folders ?? []).filter((f) => f.adding > 0);
  const moving = !!p && p.left > 0;
  const entries = (p?.waiting ?? []).map((w): Waiting => {
    const own = ownMacLine(w, bridge);
    return own ? { ...w, wait: "needs", mine: true, reason: own.reason, href: own.href } : w;
  });
  // work that waits for a computer is said in the Status view and on Settings → Computers, not over the clips;
  // what needs the person, and work no computer has taken, are said here too
  const shown = entries.filter((w) => needsYou(w) || w.wait === "stuck");
  if (!moving && !shown.length) return null;
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(OPEN_KEY, open ? "0" : "1");
    } catch {
      // a private window keeps it for this page only
    }
  };
  // Stop: every kind's queued work taken off the queue, as each Cancel in Library status does (a running job finishes)
  const stop = async () => {
    setStopping("busy");
    try {
      await stopLibrary(libraryId);
      setStopping(null);
      await progress.refresh().catch(() => {});
    } catch {
      setStopping("failed");
    }
  };
  const needs = shown.some(needsYou);
  const waiting = shown.map((w, i) => (
    <div
      key={`${w.step}${w.limit ? "-limit" : w.computer ? "-computer" : w.wait ? `-${w.wait}-${i}` : w.away ? "-away" : ""}`}
      // the plan's limit stops the AI for every tool, so it is said plainly, not as a footnote
      className={
        w.limit
          ? "flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
          : cn("flex items-center gap-2 text-xs", w.wait === "stuck" ? "text-red-600 dark:text-red-400" : "text-zinc-500")
      }
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", w.wait === "stuck" ? "bg-red-500" : w.limit || needsYou(w) ? "bg-amber-400" : "bg-zinc-400")} />
      {w.limit ? (
        <span>
          {w.count.toLocaleString()} {w.step === "look" ? (w.count === 1 ? "shot description" : "shot descriptions") : w.count === 1 ? "description" : "descriptions"} paused: {w.missing}
        </span>
      ) : w.computer ? (
        <span>
          Shot descriptions for {w.count.toLocaleString()} {w.count === 1 ? "clip need the Mac the file is on" : "clips need the Mac the files are on"}
        </span>
      ) : (
        <Needs step={w.step} count={w.count} away={w.away} reason={w.reason} href={w.href} />
      )}
    </div>
  ));
  return (
    <section aria-label="Processing" className="flex flex-col gap-1.5 text-sm">
      {moving && (
        <div className="flex items-center gap-3">
          <button type="button" aria-expanded={open} onClick={toggle} className="flex min-w-0 flex-1 flex-col gap-1.5 text-left">
            <span className="flex w-full items-center gap-2">
              <span className="min-w-0 flex-1 truncate">
                Preparing {p.clips.toLocaleString()} {p.clips === 1 ? "clip" : "clips"}
                <span className="text-zinc-500"> · {aboutTime(p.seconds)} left</span>
              </span>
              {needs && !open && <span aria-label="Needs a key or an AI provider" className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />}
              <ChevronDown className={cn("h-4 w-4 shrink-0 text-zinc-500 transition-transform", open && "rotate-180")} />
            </span>
            <MovingBar value={p.share} />
          </button>
          {stopping === "failed" && <span className="shrink-0 text-xs text-red-600 dark:text-red-400">Could not stop</span>}
          <Button variant="outline" size="sm" className="h-7 shrink-0" disabled={stopping === "busy"} onClick={() => void stop()}>
            {stopping === "busy" ? "Stopping" : "Stop"}
          </Button>
        </div>
      )}
      {moving && open && (
        // one grid for every line, so the bars start and end together
        <ul className="grid grid-cols-[minmax(0,11rem)_minmax(3rem,1fr)_auto] gap-x-3 gap-y-1 pt-1">
          {adding.map((f) => (
            <StageRow key={f.path} name={`Adding clips from ${folderName(f.path)}`} done={f.files - f.adding} of={f.files} busy />
          ))}
          {p.stages?.map((s) => <StageRow key={s.kind} name={STAGE_NAME[s.kind]} done={s.done} of={s.of} now={s.now} failed={s.failed} />)}
        </ul>
      )}
      {(!moving || open) && waiting}
    </section>
  );
}

/** One Library status line: clips from a folder left out that went to the trash because their computer went silent. */
export const leftOutLine = (x: { computer: string; clips: number }) =>
  `${x.clips.toLocaleString()} ${x.clips === 1 ? "clip" : "clips"} from a folder left out on ${x.computer} went to the trash: that computer hasn't reported for 14 days. Restore brings ${x.clips === 1 ? "it" : "them"} back.`;

/** One Library status line: clips from a folder left out hidden while a folder on that computer is unread. */
export const hiddenLine = (x: { computer: string; clips: number }) =>
  `${x.clips.toLocaleString()} ${x.clips === 1 ? "clip" : "clips"} hidden while a folder on ${x.computer} is unread`;

const PICTURE_STEPS = new Set(["probe", "thumb", "wave"]);
const STEP_WORDS: Record<NonNullable<AssetCard["preparing"]>["step"], string> = {
  blur: "Blurring faces",
  probe: "Getting its picture",
  thumb: "Getting its picture",
  wave: "Getting its picture",
  proxy: "Making a proxy",
  sprite: "Getting its frames",
  fingerprint: "Checking for duplicates",
  transcribe: "Transcribing",
  describe: "Describing",
  look: "Describing its shots",
  timeline: "Making its timeline",
  embed: "Adding to search",
};

/**
 * A clip card's line while it is prepared: the step running on it now (a soft pulse), or, before it has a picture,
 * that the picture comes. A failed clip says what failed, the tool's own words on hover. Nothing for a clip that is
 * ready or waits its turn with its picture shown. For the grid's tiles (src/pages/LibraryPage.tsx).
 */
export function ClipStage({ card, className }: { card: Pick<AssetCard, "preparing" | "failed" | "thumbUrl" | "state">; className?: string }) {
  if (card.state === "failed" && card.failed) {
    return (
      <span title={card.failed.error} className={cn("flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400", className)}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
        {failedWords(card.failed.step, card.failed.error)}
      </span>
    );
  }
  const p = card.preparing;
  if (!p || !(p.running || (!card.thumbUrl && PICTURE_STEPS.has(p.step)))) return null;
  return (
    <span className={cn("flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400", className)}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400", p.running && "motion-safe:animate-pulse")} />
      {STEP_WORDS[p.step]}
    </span>
  );
}

/** A size in GB, or MB under one GB. */
export const gbOf = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
