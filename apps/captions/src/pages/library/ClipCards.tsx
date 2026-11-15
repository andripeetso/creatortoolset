import { AudioLines, FileText, Image as ImageIcon, Video } from "lucide-react";
import type { AssetCard, AssetKind } from "@contracts/library";
import { ClipStage } from "@/components/LibraryProcessing";
import { libraryBadges } from "@/lib/library-slots";
import { cn } from "@/lib/utils";
import { AiBadge } from "./ClipPanel";

/** The Media Library's clips as cards and as list rows (LibraryPage.tsx), and their frames before the list is known. */

export const KIND_ICON: Record<AssetKind, typeof Video> = { video: Video, audio: AudioLines, image: ImageIcon, doc: FileText };

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The list view's rows before its list is known, their height: nothing moves when the list arrives. */
export function RowFrame() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-1.5">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-[58px] rounded-lg border border-zinc-800 bg-zinc-900/50" />
      ))}
    </div>
  );
}

/** The grid's boxes before its list is known, the size of the cards: nothing moves when the list arrives. */
export function TileFrame() {
  return (
    <ul aria-hidden="true" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <li key={i} className="flex flex-col gap-1.5">
          <div className="aspect-video w-full rounded-lg bg-zinc-900 ring-1 ring-zinc-500/20" />
          <div className="h-5" />
        </li>
      ))}
    </ul>
  );
}

/**
 * One clip. Its picture shows the moment there is one; before that a clip being prepared says so, quietly and moving
 * (never amber: amber is for what needs the person). A failed clip says why; a missing one (its drive unplugged) says so.
 */
export type Drag = { draggable: boolean; onDragStart: (e: React.DragEvent) => void };

export function AssetTile({ asset: a, onOpen, drag }: { asset: AssetCard; onOpen: () => void; drag?: Drag }) {
  const Icon = KIND_ICON[a.kind];
  const preparing = a.state === "processing" && !a.thumbUrl;
  return (
    <button type="button" onClick={onOpen} data-state={a.state} {...drag} className="group flex w-full min-w-0 flex-col gap-1.5 text-left">
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-zinc-500/20 transition group-hover:ring-zinc-400/60">
        {a.thumbUrl ? (
          <img src={a.thumbUrl} alt="" loading="lazy" className={cn("h-full w-full object-cover", a.state === "missing" && "opacity-40")} />
        ) : (
          <div className={cn("flex h-full w-full flex-col items-center justify-center gap-1.5 text-zinc-600", preparing && "motion-safe:animate-pulse")}>
            <Icon className="h-7 w-7" />
            {/* the clip's own step when the server says it ("Getting its picture"), else the plain word */}
            {preparing && (a.preparing ? <ClipStage card={a} /> : <span className="text-xs text-zinc-400">Preparing</span>)}
          </div>
        )}
        {a.durationS !== undefined && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-white">
            {clock(a.durationS)}
          </span>
        )}
        {(a.state === "missing" || (a.state === "failed" && !a.failed)) && (
          // on the picture's own dark label in both themes: white words, the colour in the dot (red failed, amber needs the person)
          <span className="absolute left-1.5 top-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[11px] text-white">
            <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", a.state === "failed" ? "bg-red-500" : "bg-amber-500")} />
            {/* a failed clip whose step is known says which one under its name (ClipStage) */}
            <span className="truncate">{a.state === "failed" ? "Couldn't read this file" : "File not found"}</span>
          </span>
        )}
      </div>
      <span className="truncate text-sm font-medium">{a.title}</span>
      {/* the step running on this clip now, or what failed; nothing for a clip that is ready or waits its turn */}
      {(a.thumbUrl || a.state === "failed") && <ClipStage card={a} />}
      {libraryBadges(a).map((b) => (
        <span key={b.label} className="w-fit rounded bg-zinc-500/20 px-1 py-px text-[10px] font-medium text-zinc-400">
          {b.label}
        </span>
      ))}
      {a.description && (
        <span className="line-clamp-2 text-xs text-zinc-500">
          {a.description.source === "ai" && <AiBadge />}
          {a.description.text}
        </span>
      )}
    </button>
  );
}

/** One clip in the list view: its picture, name, the step running on it and its length, as a folder's row. */
export function AssetRow({ asset: a, onOpen, drag }: { asset: AssetCard; onOpen: () => void; drag?: Drag }) {
  const Icon = KIND_ICON[a.kind];
  return (
    <button
      type="button"
      onClick={onOpen}
      data-state={a.state}
      {...drag}
      className="flex w-full items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-left transition-colors hover:border-violet-500/50"
    >
      <div className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-zinc-950 text-zinc-600">
        {a.thumbUrl ? <img src={a.thumbUrl} alt="" loading="lazy" className={cn("h-full w-full object-cover", a.state === "missing" && "opacity-40")} /> : <Icon className="h-4 w-4" />}
      </div>
      <span className="min-w-0 flex-1 truncate text-sm">{a.title}</span>
      {a.state === "missing" ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-500">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          File not found
        </span>
      ) : (
        <ClipStage card={a} className="shrink-0" />
      )}
      {a.durationS !== undefined && <span className="shrink-0 font-mono text-[11px] text-zinc-500">{clock(a.durationS)}</span>}
    </button>
  );
}
