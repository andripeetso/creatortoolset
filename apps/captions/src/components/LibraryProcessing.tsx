import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { LibraryEstimate, LibraryProgress, LibraryStepEstimate } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { getEstimate, getProgress, type Drop, listLibraries } from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";

/**
 * The Media Library's processing, said in time and money: a bar with the time left while clips are being prepared, and
 * before a big upload what it will take (api/library/estimate.ts). Both read this server's own pace.
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

/** While a library has work left: how far it is and how long the rest takes, plus anything waiting for a key. */
export function LibraryProgressBar({ libraryId }: { libraryId: string }) {
  const p = useCachedLoad<LibraryProgress>(`/api/library/${libraryId}/progress`, () => getProgress(libraryId)).data;
  if (!p || (!p.left && !p.waiting.length)) return null;
  const what = { files: ["file", "files"], transcript: ["transcript", "transcripts"], describe: ["AI description", "AI descriptions"], embed: ["search entry", "search entries"] };
  return (
    <section aria-label="Processing" className="flex flex-col gap-1.5 text-sm">
      {p.left > 0 && (
        <>
          <div className="flex items-center justify-between gap-3">
            <span>
              Preparing {p.clips.toLocaleString()} {p.clips === 1 ? "clip" : "clips"}
            </span>
            <span className="shrink-0 text-xs text-zinc-500">{aboutTime(p.seconds)} left</span>
          </div>
          <Progress value={(p.done / Math.max(1, p.done + p.left)) * 100} className="h-1.5" />
        </>
      )}
      {p.waiting.map((w) => (
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
