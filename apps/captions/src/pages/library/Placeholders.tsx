import { AlertCircle, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { aboutTime, aboutUsd } from "@/components/LibraryProcessing";
import { cn } from "@/lib/utils";
import type { Upload } from "./Uploads";

/**
 * A drop's files as they go in (11-19, the way a photo library fills in): each is a card in the grid at once, a grey
 * frame with its name; working, a thin bar runs along its foot; once indexed the clip's own card takes its place. A
 * failed one has a red mark and Try again; Cancel is in its menu. Above the grid one quiet line counts them, with Cancel
 * all. There is no list of uploads.
 */

/** Still to go or on its way. */
export const going = (u: Upload) => u.status === "waiting" || u.status === "checking" || u.status === "copying" || u.status === "uploading";
const working = (u: Upload) => u.status === "checking" || u.status === "copying" || u.status === "uploading";
const done = (u: Upload) => u.status === "added" || u.status === "duplicate";

/** A file's card while it goes in: shown while going or failed, and once added until its clip's card is on the page. */
export const placeholderShown = (u: Upload, onPage: (assetId: string) => boolean) =>
  going(u) || u.status === "failed" || (u.status === "added" && !!u.assetId && !onPage(u.assetId));

export function PlaceholderTile({ upload: u, onRetry, onCancel }: { upload: Upload; onRetry: () => void; onCancel: () => void }) {
  const failed = u.status === "failed";
  // the copy's bytes show how far it is; the other steps run the bar without a length
  const part = u.status === "copying" || (u.status === "uploading" && !u.inPlace) ? u.sent / Math.max(1, u.file.size) : null;
  return (
    <div data-placeholder={u.status} className="group relative flex flex-col gap-1.5" title={failed ? u.error : undefined}>
      <div className={cn("relative aspect-video overflow-hidden rounded-lg bg-zinc-200 dark:bg-zinc-800", failed && "ring-1 ring-red-500/60")}>
        {working(u) && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/10" aria-label="Adding">
            {part === null ? <div className="h-full w-1/3 animate-pulse bg-[var(--tint)]" /> : <div className="h-full bg-[var(--tint)] transition-[width]" style={{ width: `${Math.round(part * 100)}%` }} />}
          </div>
        )}
        {failed && <AlertCircle aria-label="Not added" className="absolute left-2 top-2 h-4 w-4 text-red-500" />}
        {failed && (
          <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}
        {(going(u) || failed) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label={`More for ${u.file.name}`} className="absolute right-1 top-1 h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {failed && <DropdownMenuItem onSelect={onRetry}>Retry</DropdownMenuItem>}
              {going(u) && <DropdownMenuItem onSelect={onCancel}>Cancel</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <p className="truncate text-xs text-zinc-500">{u.file.name}</p>
    </div>
  );
}

/** The line's words: "Adding 58 clips · 12 done · about 9 min left · about $11" (the cost only when given). */
export function summaryLine(uploads: readonly Upload[], startedAt: number, now: number, usd: number | null): string | null {
  const batch = uploads.filter((u) => u.status !== "cancelled");
  if (!batch.some(going)) return null;
  const n = batch.length;
  const finished = batch.filter(done).length;
  const failed = batch.filter((u) => u.status === "failed").length;
  const parts = [`Adding ${n.toLocaleString()} ${n === 1 ? "clip" : "clips"}`, `${finished.toLocaleString()} done`];
  if (failed) parts.push(`${failed} not added`);
  // the pace so far: what is left at the rate the finished ones took
  const left = batch.filter(going).length;
  if (finished > 0) parts.push(`${aboutTime(((now - startedAt) / 1000 / finished) * left)} left`);
  if (usd !== null && usd > 0) parts.push(aboutUsd(usd));
  return parts.join(" · ");
}

export function ImportSummary({ line, onCancelAll }: { line: string; onCancelAll: () => void }) {
  return (
    <div role="status" className="flex items-center gap-3 text-xs text-zinc-500">
      <span>{line}</span>
      <button type="button" className="underline-offset-4 hover:underline" onClick={onCancelAll}>
        Cancel all
      </button>
    </div>
  );
}
