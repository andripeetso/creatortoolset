import { useState, type ReactNode } from "react";
import type { AssetCard } from "@contracts/library";
import { cn } from "@/lib/utils";
import { cardColumns } from "./views";
import { across, clock, frameAt, frameStyle, KIND_ICON, PhotoMasonry, type Drag } from "./ClipCards";

/**
 * The Gallery view (LibraryPage.tsx): only clips, big and edge to edge across the open tab. Tall clips stand in one
 * column, wide ones take two at the same height; the length and the tags sit on the picture, the name shows under the
 * pointer, and a mouse across a video scrubs it. Only photos: in their own proportions, in columns.
 */

const wide = (a: AssetCard) => !!a.width && !!a.height && a.width > a.height * 1.1;

/** `size`: the folders view's card size (views.tsx); a tall clip here is about half a card. */
export function GalleryGrid({ assets, size, tile }: { assets: readonly AssetCard[]; size?: number | null; tile: (a: AssetCard, ownShape: boolean) => ReactNode }) {
  if (assets.length && assets.every((a) => a.kind === "image")) return <PhotoMasonry assets={assets} tile={(a) => tile(a, true)} />;
  return (
    <div
      className={cn("grid grid-flow-row-dense gap-2", size ? "" : "grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(170px,1fr))]")}
      style={size ? cardColumns(Math.round(size * 0.45)) : undefined}
    >
      {assets.map((a) => (
        <div key={a.id} className={cn("min-w-0", wide(a) && "col-span-2")}>
          {tile(a, false)}
        </div>
      ))}
    </div>
  );
}

export function GalleryTile({ asset: a, onOpen, drag, ownShape }: { asset: AssetCard; onOpen: () => void; drag?: Drag; ownShape: boolean }) {
  const Icon = KIND_ICON[a.kind];
  const [at, setAt] = useState<number | null>(null);
  const strip = a.kind === "video" ? a.spriteUrl : undefined;
  const scrub = strip
    ? {
        onPointerMove: (e: React.PointerEvent<HTMLElement>) => e.pointerType === "mouse" && setAt(across(e)),
        onPointerLeave: () => setAt(null),
      }
    : {};
  const tags = [...a.tags].slice(0, 3);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-state={a.state}
      title={a.title}
      {...drag}
      {...scrub}
      style={ownShape ? { aspectRatio: `${a.width || 4} / ${a.height || 3}` } : undefined}
      className={cn(
        "group relative block w-full overflow-hidden rounded-md bg-zinc-900 text-left ring-1 ring-zinc-500/20 transition hover:ring-zinc-400/60",
        !ownShape && (wide(a) ? "aspect-[3/2]" : "aspect-[3/4]"),
      )}
    >
      {a.thumbUrl ? (
        <img src={a.thumbUrl} alt="" loading="lazy" className={cn("h-full w-full object-cover", a.state === "missing" && "opacity-40")} />
      ) : (
        <div className={cn("flex h-full w-full flex-col items-center justify-center gap-1.5 text-zinc-600", a.state === "processing" && "motion-safe:animate-pulse")}>
          <Icon className="h-7 w-7" />
          {a.state === "processing" && <span className="text-xs text-zinc-400">Preparing</span>}
        </div>
      )}
      {strip && at !== null && (
        <>
          <div aria-hidden data-scrub className="absolute inset-0 bg-zinc-950" style={frameStyle(strip, frameAt(at))} />
          <div aria-hidden className="absolute bottom-0 left-0 h-0.5 bg-white/90" style={{ width: `${at * 100}%` }} />
        </>
      )}
      {/* on the picture's own dark labels: white words in both themes */}
      {tags.length > 0 && (
        <span className="absolute left-1.5 right-14 top-1.5 flex flex-wrap gap-1 overflow-hidden">
          {tags.map((t) => (
            <span key={t} className="max-w-full truncate rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white">
              {t}
            </span>
          ))}
        </span>
      )}
      {a.durationS !== undefined && (
        <span className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-white">{clock(a.durationS)}</span>
      )}
      {(a.state === "missing" || a.state === "failed") && (
        <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[11px] text-white">
          <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", a.state === "failed" ? "bg-red-500" : "bg-amber-500")} />
          {a.state === "failed" ? "Couldn't read this file" : "File not found"}
        </span>
      )}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-5 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        {a.title}
      </span>
    </button>
  );
}
