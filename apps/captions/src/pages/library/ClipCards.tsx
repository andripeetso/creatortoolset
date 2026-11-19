import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react";
import { AudioLines, FileText, Image as ImageIcon, Laptop, Video } from "lucide-react";
import { SPRITE_FRAMES, type AssetCard, type AssetKind } from "@contracts/library";
import { ClipStage } from "@/components/LibraryProcessing";
import { libraryBadges } from "@/lib/library-slots";
import { cn } from "@/lib/utils";
import { placeLine } from "@/lib/wording";

/** The Media Library's clips as cards and as list rows (LibraryPage.tsx), and their frames before the list is known. */

export const KIND_ICON: Record<AssetKind, typeof Video> = { video: Video, audio: AudioLines, image: ImageIcon, doc: FileText };

/** A photo that is in, with no picture (the computer that has it couldn't make one yet): said on its card, quietly. */
export const noPictureYet = (a: AssetCard) => a.kind === "image" && !a.thumbUrl && a.state !== "processing" && a.state !== "missing";
export function NoPictureChip() {
  return <span className="rounded-full border border-zinc-500/30 px-2 py-0.5 text-[11px] text-zinc-400">No picture yet</span>;
}

/** The small mark of a clip on this computer (its proxy cached here, or its file indexed here): the card's `here`. */
export const HereMark = ({ className }: { className?: string }) => (
  <span role="img" aria-label={placeLine({ word: "here" })} title={placeLine({ word: "here" })} className={className}>
    <Laptop aria-hidden className="h-3 w-3" />
  </span>
);

/** The words that need saying on a card about its file (a missing file, a drive away, a folder not found or not allowed);
 *  none for a clip that is fine or not checked yet. A clip the server marked missing says its place word when it has one
 *  ("Not checked yet" for a file nobody has looked for), else "File not found". */
const ATTENTION = new Set(["missing", "disk_away", "folder_not_found", "needs_ok"]);
export function fileLine(a: AssetCard): string | null {
  if (a.state === "failed" && !a.failed) return "Could not read the file";
  const w = a.placeWord;
  if (w && (ATTENTION.has(w.word) || (a.state === "missing" && w.word !== "here" && w.word !== "on" && w.word !== "found"))) return placeLine(w);
  return a.state === "missing" && !w ? "File not found" : null;
}
const isHere = (a: AssetCard) => !!a.here || a.placeWord?.word === "here" || a.placeWord?.word === "found";

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
export function TileFrame({ columns }: { columns?: CSSProperties }) {
  return (
    <ul aria-hidden="true" className={columns ? "grid gap-3" : "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"} style={columns}>
      {Array.from({ length: 8 }, (_, i) => (
        <li key={i} className="flex flex-col gap-1.5">
          <div className="aspect-video w-full rounded-lg bg-zinc-900 ring-1 ring-zinc-500/20" />
          <div className="h-5" />
        </li>
      ))}
    </ul>
  );
}

/** The frame of a clip's strip (`spriteUrl`) at `frac` (0 to 1) across it. */
export const frameAt = (frac: number) => Math.min(SPRITE_FRAMES - 1, Math.max(0, Math.floor(frac * SPRITE_FRAMES)));

/**
 * Frame `i` of a strip as the background of a box, filling it the way object-cover does, never stretched: one picture, no
 * request per frame. `cell`: a frame's width / height (useStrip); `box`: the box's.
 */
export const frameStyle = (url: string, i: number, cell: number, box: number): CSSProperties => {
  const backgroundImage = `url("${url}")`;
  // the frame wider than the box: the strip as tall as the box, frame i's middle at the box's middle
  if (cell >= box) return { backgroundImage, backgroundSize: "auto 100%", backgroundPosition: `${((box / 2 - (i + 0.5) * cell) / (box - SPRITE_FRAMES * cell)) * 100}% 0` };
  return { backgroundImage, backgroundSize: `${SPRITE_FRAMES * 100}% auto`, backgroundPosition: `${(i / (SPRITE_FRAMES - 1)) * 100}% 50%` };
};

const cells = new Map<string, number>();
/**
 * A strip's frame shape (width / height) once its picture is here, null before. With `near` the picture loads once that
 * element comes within a screen of view, so a card's first hover shows frames at once; without it, at once.
 */
export function useStrip(url: string | undefined, near?: RefObject<Element | null>): number | null {
  const [cell, setCell] = useState<number | null>(null);
  useEffect(() => {
    setCell(url ? (cells.get(url) ?? null) : null);
    if (!url || cells.has(url)) return;
    let img: HTMLImageElement | null = null;
    const load = () => {
      img = new Image();
      img.onload = () => {
        const c = img!.naturalWidth / SPRITE_FRAMES / img!.naturalHeight;
        cells.set(url, c);
        setCell(c);
      };
      img.src = url;
    };
    const el = near?.current;
    let io: IntersectionObserver | undefined;
    if (el && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        (es) => {
          if (!es.some((e) => e.isIntersecting)) return;
          io?.disconnect();
          load();
        },
        { rootMargin: "100%" },
      );
      io.observe(el);
    } else load();
    return () => {
      io?.disconnect();
      if (img) img.onload = null;
    };
  }, [url, near]);
  return cell;
}

/** Where the pointer is across `el`, 0 to 1. */
export const across = (e: { clientX: number; currentTarget: Element }) => {
  const r = e.currentTarget.getBoundingClientRect();
  return r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
};

/**
 * One clip. Its picture shows the moment there is one; before that a clip being prepared says so, quietly and moving
 * (never amber: amber is for what needs the person). A failed clip says why; a missing one (its drive unplugged) says so.
 * A mouse across a video's picture shows the clip there, from its strip of frames, with a thin line for how far.
 * `ownShape`: the picture in the file's own proportions (PhotoMasonry), not 16:9.
 */
export type Drag = { draggable: boolean; onDragStart: (e: React.DragEvent) => void };

export function AssetTile({ asset: a, onOpen, drag, ownShape = false }: { asset: AssetCard; onOpen: () => void; drag?: Drag; ownShape?: boolean }) {
  const Icon = KIND_ICON[a.kind];
  const preparing = a.state === "processing" && !a.thumbUrl;
  // the pointer's place across the picture while a mouse is over it (touch never scrubs)
  const [at, setAt] = useState<number | null>(null);
  const strip = a.kind === "video" ? a.spriteUrl : undefined;
  const picture = useRef<HTMLDivElement>(null);
  const cell = useStrip(strip, picture);
  const scrub = strip
    ? {
        onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => e.pointerType === "mouse" && setAt(across(e)),
        onPointerLeave: () => setAt(null),
      }
    : {};
  const shape = `${a.width || 4} / ${a.height || 3}`;
  return (
    <button type="button" onClick={onOpen} data-state={a.state} {...drag} className="group flex w-full min-w-0 flex-col gap-1.5 text-left">
      <div
        ref={picture}
        {...scrub}
        // in its own proportions the picture sets the height once it is there (`auto`: the file's own, should it be turned)
        style={ownShape && !a.thumbUrl ? { aspectRatio: shape } : undefined}
        className={cn("relative w-full overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-zinc-500/20 transition group-hover:ring-zinc-400/60", !ownShape && "aspect-video")}
      >
        {a.thumbUrl ? (
          <img
            src={a.thumbUrl}
            alt=""
            loading="lazy"
            style={ownShape ? { aspectRatio: `auto ${shape}` } : undefined}
            className={cn(ownShape ? "block h-auto w-full" : "h-full w-full object-cover", a.state === "missing" && "opacity-40")}
          />
        ) : (
          <div className={cn("flex h-full w-full flex-col items-center justify-center gap-1.5 text-zinc-600", preparing && "motion-safe:animate-pulse")}>
            <Icon className="h-7 w-7" />
            {/* the clip's own step when the server says it ("Getting its picture"), else the plain word */}
            {preparing && (a.preparing ? <ClipStage card={a} /> : <span className="text-xs text-zinc-400">Preparing</span>)}
            {noPictureYet(a) && <NoPictureChip />}
          </div>
        )}
        {/* the picture stays until the strip is here */}
        {strip && cell && at !== null && (
          <>
            <div aria-hidden data-scrub className="absolute inset-0" style={frameStyle(strip, frameAt(at), cell, ownShape ? (a.width || 4) / (a.height || 3) : 16 / 9)} />
            <div aria-hidden className="absolute bottom-0 left-0 h-0.5 bg-white/90" style={{ width: `${at * 100}%` }} />
          </>
        )}
        {isHere(a) && <HereMark className="absolute bottom-1.5 left-1.5 rounded bg-black/70 p-1 text-white" />}
        {a.durationS !== undefined && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-white">
            {clock(a.durationS)}
          </span>
        )}
        {fileLine(a) && (
          // on the picture's own dark label in both themes: white words, the colour in the dot (red failed, amber needs the person)
          <span className="absolute left-1.5 top-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[11px] text-white">
            <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", a.state === "failed" ? "bg-red-500" : "bg-amber-500")} />
            {/* a failed clip whose step is known says which one under its name (ClipStage) */}
            <span className="truncate">{fileLine(a)}</span>
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
          {a.description.text}
        </span>
      )}
    </button>
  );
}

/**
 * The list view's columns, one grid for the header and every row: Name · Date filmed · Date added · Length · Size · Kind
 * · Roll. They come in as the list's own width allows (the cliplist container, tailwind.config.js cl1…cl5), right to left,
 * with Length always shown (it was on every row before the columns); Name takes the rest and truncates.
 */
export const LIST_COLS =
  "grid items-center gap-x-3 grid-cols-[minmax(0,1fr)_3.5rem] cl1:grid-cols-[minmax(0,1fr)_6.5rem_3.5rem] cl2:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_3.5rem] cl3:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_3.5rem_4.5rem] cl4:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_3.5rem_4.5rem_4.5rem] cl5:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_3.5rem_4.5rem_4.5rem_3.5rem]";
/** Each column's cell, shown from its width on (in the order of LIST_COLS). */
export const COL = { filmed: "hidden cl1:block", added: "hidden cl2:block", length: "", size: "hidden cl3:block", kind: "hidden cl4:block", roll: "hidden cl5:block" } as const;
/** The list's container: the columns follow its width, not the window's (beside a chat it is half the window). */
export const LIST_CONTAINER: CSSProperties = { containerType: "inline-size", containerName: "cliplist" };

export const KIND_WORD: Record<AssetKind, string> = { video: "Video", image: "Photo", audio: "Audio", doc: "Document" };
const day = (ms?: number) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
const sizeWord = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** One clip in the list view: its picture, name and the step running on it, then the columns (LIST_COLS). */
export function AssetRow({ asset: a, onOpen, drag }: { asset: AssetCard; onOpen: () => void; drag?: Drag }) {
  const Icon = KIND_ICON[a.kind];
  const cell = "truncate text-xs text-zinc-500";
  return (
    <button
      type="button"
      onClick={onOpen}
      data-state={a.state}
      {...drag}
      className={cn(LIST_COLS, "w-full rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-left transition-colors hover:border-violet-500/50")}
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-zinc-950 text-zinc-600">
          {a.thumbUrl ? <img src={a.thumbUrl} alt="" loading="lazy" className={cn("h-full w-full object-cover", a.state === "missing" && "opacity-40")} /> : <Icon className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{a.title}</span>
        {isHere(a) && <HereMark className="shrink-0 text-zinc-500" />}
        {fileLine(a) && a.state !== "failed" ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-500">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            {fileLine(a)}
          </span>
        ) : (
          <ClipStage card={a} className="shrink-0" />
        )}
      </span>
      {/* Date filmed is the file's own date; with none the clip sorts by when it was added, and the cell stays empty */}
      <span className={cn(cell, COL.filmed)}>{day(a.capturedAt)}</span>
      <span className={cn(cell, COL.added)}>{day(a.addedAt)}</span>
      <span className="text-right font-mono text-[11px] text-zinc-500">{a.durationS !== undefined ? clock(a.durationS) : ""}</span>
      <span className={cn(cell, "text-right", COL.size)}>{a.bytes ? sizeWord(a.bytes) : ""}</span>
      <span className={cn(cell, COL.kind)}>{KIND_WORD[a.kind]}</span>
      <span className={cn(cell, COL.roll)}>{a.roll ? `${a.roll.toUpperCase()}-roll` : ""}</span>
    </button>
  );
}

/** Columns for the photos, as the cards grid has them (FolderGrid "small"). */
const COLUMNS = [["(min-width: 1024px)", 4], ["(min-width: 640px)", 3]] as const;
const columnCount = () => COLUMNS.find(([q]) => matchMedia(q).matches)?.[1] ?? 2;
const onColumns = (change: () => void) => {
  const all = COLUMNS.map(([q]) => matchMedia(q));
  for (const m of all) m.addEventListener("change", change);
  return () => all.forEach((m) => m.removeEventListener("change", change));
};

/**
 * Items into `cols` columns, each to the shortest so far (`tall`: an item's height for a column's width). A page that
 * comes in after places only its own items: what is shown never moves to another column.
 */
export function intoColumns<T>(items: readonly T[], cols: number, tall: (t: T) => number): T[][] {
  const out = Array.from({ length: cols }, () => [] as T[]);
  const height = Array.from({ length: cols }, () => 0);
  for (const it of items) {
    const i = height.indexOf(Math.min(...height));
    out[i]!.push(it);
    height[i]! += tall(it);
  }
  return out;
}

/** Photos in their own proportions, in columns: the cards view when only images are shown (LibraryPage.tsx). */
export function PhotoMasonry({ assets, tile }: { assets: readonly AssetCard[]; tile: (a: AssetCard) => ReactNode }) {
  const cols = useSyncExternalStore(onColumns, columnCount, () => 2);
  // the name under each picture counts as a fifth of a width
  const columns = intoColumns(assets, cols, (a) => (a.width && a.height ? a.height / a.width : 0.75) + 0.2);
  return (
    <div className="flex items-start gap-3">
      {columns.map((c, i) => (
        <div key={i} className="flex min-w-0 flex-1 flex-col gap-3">
          {c.map((a) => (
            <Fragment key={a.id}>{tile(a)}</Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}
