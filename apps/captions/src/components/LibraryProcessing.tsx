import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { AssetCard, LibraryEstimate, LibraryProgress, LibraryStage, LibraryStepEstimate, WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { getEstimate, getProgress, getWatch, type Drop, listLibraries } from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { cn } from "@/lib/utils";

/**
 * The Media Library's processing, said in time and money: a line per step with the time left while clips are being
 * prepared, and before a big upload what it will take (api/library/estimate.ts). Both read this server's own pace.
 */

/** Uploads of this many files or more ask first, with the estimate. */
export const BIG_DROP = 20;

/** GET /api/library/:id/watch/size: the media files a folder holds. */
export interface FolderSize {
  files: number;
  bytes: number;
  audio: number;
  audioBytes: number;
}

export const dropOf = (s: FolderSize, music = false): Drop => ({ clips: s.files, bytes: s.bytes, audio: s.audio, audioBytes: s.audioBytes, music });

export function aboutTime(s: number): string {
  if (s < 60) return "under a minute";
  const m = Math.round(s / 60);
  if (m < 60) return `about ${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `about ${h} h${rest ? ` ${rest} min` : ""}`;
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

export function aboutUsd(usd: number): string {
  if (usd < 0.01) return "under a cent";
  return `about $${usd < 10 ? usd.toFixed(2) : Math.round(usd).toLocaleString()}`;
}

/** One line per step that runs or waits; a step switched off says nothing. */
export function stepLine(s: LibraryStepEstimate): string | null {
  if (s.route === "off") return null;
  const what = { files: "Thumbnails and playable copies", transcript: "Transcripts", describe: "AI descriptions", embed: "Search by meaning" }[s.step];
  if (s.route === "none") return s.step === "embed" ? null : `${what} wait: ${s.missing}`;
  const on = {
    server: "on this server, free",
    device: "on this computer, free",
    deepgram: `on your Deepgram key, ${aboutUsd(s.usd)}`,
    openai: `on your OpenAI key, ${aboutUsd(s.usd)}`,
    api: `on your Anthropic key, ${aboutUsd(s.usd)}`,
    budget: `on your team's AI budget, ${aboutUsd(s.usd)}`,
    provider: `on your connected AI, ${aboutUsd(s.usd)} of usage at API prices (your plan pays; it counts toward its limits)`,
  }[s.route];
  return `${what} ${on}`;
}

/** A folder's own name, the way the person knows it ("/Volumes/Card/Trip" → "Trip"). */
export const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Each step of preparing, in the words of the person who watches it go by (api/library/estimate.ts STAGES). */
const STAGE_NAME: Record<LibraryStage["kind"], string> = {
  thumb: "Pictures",
  proxy: "Lighter copies",
  fingerprint: "Duplicate checks",
  transcribe: "Transcripts",
  describe: "AI descriptions",
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

/**
 * While a library has work left: a footage folder still being read (how many of its clips are in), then one line per
 * step of the preparing, in the order they run (pictures, lighter copies, duplicate checks, transcripts, descriptions),
 * each counting up as its clips go through, with the time the rest takes; plus anything waiting for a key or a limit.
 */
export function LibraryProgressBar({ libraryId }: { libraryId: string }) {
  const p = useCachedLoad<LibraryProgress>(`/api/library/${libraryId}/progress`, () => getProgress(libraryId)).data;
  // the same saved status as the folder card and the watch list; only the owner gets one
  const watch = useCachedLoad<WatchStatus>(`/api/library/${libraryId}/watch`, () => getWatch(libraryId)).data;
  const adding = (watch?.folders ?? []).filter((f) => f.adding > 0);
  if (!adding.length && (!p || (!p.left && !p.waiting.length))) return null;
  const what = { files: ["file", "files"], transcript: ["transcript", "transcripts"], describe: ["AI description", "AI descriptions"], embed: ["search entry", "search entries"] };
  return (
    <section aria-label="Processing" className="flex flex-col gap-1.5 text-sm">
      {p && p.left > 0 && (
        <div className="flex items-center justify-between gap-3">
          <span>
            Preparing {p.clips.toLocaleString()} {p.clips === 1 ? "clip" : "clips"}
          </span>
          <span className="shrink-0 text-xs text-zinc-500">{aboutTime(p.seconds)} left</span>
        </div>
      )}
      {/* one grid for every line, so the bars start and end together */}
      <ul className="grid grid-cols-[minmax(0,11rem)_minmax(3rem,1fr)_auto] gap-x-3 gap-y-1">
        {adding.map((f) => (
          <StageRow key={f.path} name={`Adding clips from ${folderName(f.path)}`} done={f.files - f.adding} of={f.files} busy />
        ))}
        {p && p.left > 0 && p.stages?.map((s) => <StageRow key={s.kind} name={STAGE_NAME[s.kind]} done={s.done} of={s.of} now={s.now} failed={s.failed} />)}
      </ul>
      {p?.waiting.map((w) => (
        <div
          key={`${w.step}${w.limit ? "-limit" : ""}`}
          // the plan's limit stops the AI for every tool, so it is said plainly, not as a footnote
          className={w.limit ? "flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300" : "flex items-center gap-2 text-xs text-zinc-400"}
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
          <span>
            {w.count.toLocaleString()} {what[w.step][w.count === 1 ? 0 : 1]} {w.count === 1 ? "waits" : "wait"}: {w.missing}
          </span>
        </div>
      ))}
    </section>
  );
}

const PICTURE_STEPS = new Set(["probe", "thumb", "wave"]);
const STEP_WORDS: Record<NonNullable<AssetCard["preparing"]>["step"], string> = {
  probe: "Getting its picture",
  thumb: "Getting its picture",
  wave: "Getting its picture",
  proxy: "Making a lighter copy",
  fingerprint: "Checking for duplicates",
  transcribe: "Transcribing",
  describe: "Describing",
  embed: "Adding to search",
};
const FAILED_WORDS: Record<NonNullable<AssetCard["failed"]>["step"], string> = {
  probe: "This file can't be read as video or sound",
  thumb: "Its picture could not be made",
  wave: "Its sound could not be read",
  proxy: "Its lighter copy could not be made",
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
        {FAILED_WORDS[card.failed.step]}
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

/** Before a big upload or folder: what preparing `clips` files of `bytes` in all takes, and the go (`go` names it). */
export function BigUploadDialog({
  libraryId,
  drop,
  title,
  go,
  onUpload,
  onClose,
}: {
  libraryId: string;
  drop: Drop;
  title: string;
  go: string;
  onUpload: () => void;
  onClose: () => void;
}) {
  const [e, setE] = useState<LibraryEstimate | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const { clips, bytes, audio, audioBytes, music } = drop;
  useEffect(() => {
    getEstimate(libraryId, { clips, bytes, audio, audioBytes, music }).then(setE, (x: unknown) => setFailed(x instanceof Error ? x.message : String(x)));
  }, [libraryId, clips, bytes, audio, audioBytes, music]);
  const guess = e?.steps.some((s) => !s.measured && s.route !== "off" && s.route !== "none");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{e ? `${cap(aboutTime(e.minutes * 60))} of footage.` : (failed ?? "Working out what it takes…")}</DialogDescription>
        {e && (
          <div className="flex flex-col gap-2 text-sm">
            <ul className="flex flex-col gap-1">
              {e.steps.map(stepLine).filter(Boolean).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p>
              Ready in {aboutTime(e.seconds)}{guess ? " (a first guess: it gets closer after the first clips)" : ""}.
            </p>
            {e.withApiKey && (
              <p className="text-zinc-400">
                With your own Anthropic key in{" "}
                <Link to="/settings/keys" className="underline">
                  Settings → API keys
                </Link>
                , the AI descriptions run six at a time: ready in {aboutTime(e.withApiKey.seconds)}, {aboutUsd(e.withApiKey.usd)} on that key.
              </p>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onUpload}>{go}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A folder on this computer about to join the account's own Library, from a screen that has no library open (setup's
 * Folders step, Settings → Storage): `check(path, add)` adds a small folder at once, and for a big one (BIG_DROP files or
 * more) shows the same dialog first, where Add folder runs `add` and Cancel adds nothing. A folder the server can't
 * size (not on this computer, not a folder) goes to `add` as before, which says why. `dialog` is rendered by the caller.
 */
export function useBigFolder(): { check: (path: string, add: () => unknown, opts?: { music?: boolean }) => Promise<void>; dialog: ReactNode } {
  const [asking, setAsking] = useState<{ libraryId: string; files: number; drop: Drop; add: () => unknown } | null>(null);
  // `music`: a music folder, whose files get no transcript, description or search by meaning (api/library/worker.ts)
  const check = async (path: string, add: () => unknown, opts: { music?: boolean } = {}) => {
    // the account's own library is the first of its own (api/library/watch.ts addWatchFolder takes the same one)
    const libraryId = (await listLibraries().catch(() => []))[0]?.id;
    const r = libraryId ? await fetch(`/api/library/${libraryId}/watch/size?path=${encodeURIComponent(path)}`).catch(() => null) : null;
    const size = r?.ok ? ((await r.json()) as FolderSize) : null;
    if (libraryId && size && size.files >= BIG_DROP) setAsking({ libraryId, files: size.files, drop: dropOf(size, opts.music), add });
    else await add();
  };
  const dialog = asking && (
    <BigUploadDialog
      libraryId={asking.libraryId}
      drop={asking.drop}
      title={`Add ${asking.files.toLocaleString()} files from this folder?`}
      go="Add folder"
      onClose={() => setAsking(null)}
      onUpload={() => {
        void asking.add();
        setAsking(null);
      }}
    />
  );
  return { check, dialog };
}
