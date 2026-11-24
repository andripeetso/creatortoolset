import { AlertCircle, Check, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { aboutTime, aboutUsd } from "@/components/LibraryProcessing";
import type { AssetCard } from "@contracts/library";
import { cn } from "@/lib/utils";
import { wideShape } from "./Gallery";
import type { Upload } from "./Uploads";

/**
 * A drop's files as they go in (11-19, the way a photo library fills in): each is a card in the grid at once, a grey
 * frame with its name; waiting, it says Queued; working, a thin bar runs along its foot; added, a green check until the clip's own card takes its place. A
 * failed one has a red mark and Retry; Cancel is in its menu. Above the grid one quiet line counts them, with Cancel
 * all. There is no list of uploads. A card is the size its clip's card will be, so nothing moves when it takes its
 * place (11-19, Andri: "fill the row height"): in the Gallery the file's own shape (tall: a cell, wide: two) once read,
 * the library's usual shape before; in the other views the clip card's frame. It fills its row's height either way.
 */

/** The library's usual shape (width / height): the middle one of the clips on the page; none, a phone's (portrait). */
export function commonAspect(cards: readonly Pick<AssetCard, "width" | "height">[]): number {
  const all = cards.flatMap((a) => (a.width && a.height ? [a.width / a.height] : [])).sort((x, y) => x - y);
  return all.length ? all[Math.floor(all.length / 2)]! : 9 / 16;
}

/** Wide in the Gallery: two cells like a wide clip's card. */
export const placeholderWide = (u: Upload, usual: number) => wideShape(u.aspect ?? usual);

/** Still to go or on its way. */
export const going = (u: Upload) => u.status === "waiting" || u.status === "checking" || u.status === "copying" || u.status === "uploading";
const working = (u: Upload) => u.status === "checking" || u.status === "copying" || u.status === "uploading";
const done = (u: Upload) => u.status === "added" || u.status === "duplicate";

/** A file's card while it goes in: shown while going or failed, and once added until its clip's card is on the page. */
export const placeholderShown = (u: Upload, onPage: (assetId: string) => boolean) =>
  going(u) || u.status === "failed" || (u.status === "added" && !!u.assetId && !onPage(u.assetId));

/** `gallery`: the Gallery's cell (its name on the picture, `wide` two cells); else the clip card's frame with the name under it. */
export function PlaceholderTile({ upload: u, onRetry, onCancel, gallery, wide }: { upload: Upload; onRetry: () => void; onCancel: () => void; gallery?: boolean; wide?: boolean }) {
  const failed = u.status === "failed";
  // the copy's bytes show how far it is; the other steps run the bar without a length
  const part = u.status === "copying" || (u.status === "uploading" && !u.inPlace) ? u.sent / Math.max(1, u.file.size) : null;
  return (
    <div data-placeholder={u.status} className="group relative flex h-full flex-col gap-1.5" title={failed ? u.error : undefined}>
      {/* the clip cards' own frame colour; its height grows to the row's (flex-1), its shape the least */}
      <div
        data-frame
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden bg-zinc-900 ring-1 ring-zinc-500/20",
          gallery ? (wide ? "aspect-[3/2] rounded-md" : "aspect-[3/4] rounded-md") : "aspect-video rounded-lg",
          failed && "ring-red-500/60",
        )}
      >
        {gallery && <span className="absolute inset-x-0 bottom-2.5 truncate px-2 text-xs text-zinc-500">{u.file.name}</span>}
        {working(u) && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/10" aria-label="Adding">
            {part === null ? <div className="h-full w-1/3 animate-pulse bg-violet-600" /> : <div className="h-full bg-violet-600 transition-[width]" style={{ width: `${Math.round(part * 100)}%` }} />}
          </div>
        )}
        {/* a card still to start and one already in look alike otherwise, so a drop seemed to run from its middle (11-24) */}
        {u.status === "waiting" && <span className="absolute left-2 top-2 text-xs text-zinc-500">Queued</span>}
        {done(u) && <Check aria-label="Added" className="absolute left-2 top-2 h-4 w-4 text-emerald-500" />}
        {failed && <AlertCircle aria-label="Not added" className="absolute left-2 top-2 h-4 w-4 text-red-500" />}
        {failed && (
          <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Retry
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
      {!gallery && <p className="truncate text-xs text-zinc-500">{u.file.name}</p>}
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
