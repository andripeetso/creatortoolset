import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Clapperboard, GalleryHorizontalEnd, ImageOff, Layers, LayoutGrid, Loader2, RotateCcw } from "lucide-react";
import type { AssetCard, Collection, LibrarySummary, Piece } from "@contracts/library";
import { LibraryFacetBar } from "@/components/LibraryFacetBar";
import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/ui/button";
import { getWorkshopFinals, isFinals, listAllAssets, listCollections, listLibraries, listPieces, listTrashedPieces, restorePiece, useLibraryChanges, type WorkshopFinal } from "@/lib/library";
import { libraryBadges, libraryFacets, pickedFor } from "@/lib/library-slots";
import { cn } from "@/lib/utils";

/**
 * Finals (/finals): the library's Finals collection shown as pieces. A piece is one reel, carousel or other item made
 * of library versions with one winner. This page reads the same library tables as /library (pieces, assets, shares)
 * and keeps no store of its own; the plug-in facets and badges of the Media Library apply here too.
 */

export type FinalsKind = "reel" | "carousel" | "other";

export interface FinalsTile {
  piece: Piece;
  kind: FinalsKind;
  /** the winner's card; absent when its version is not in the list (an old version, or a source with no card) */
  card?: AssetCard;
  cover?: string;
  posted: boolean;
}

const KIND_LABEL: Record<FinalsKind, string> = { reel: "Reel", carousel: "Carousel", other: "Other" };
const KIND_ICON = { reel: Clapperboard, carousel: GalleryHorizontalEnd, other: Layers } as const;
/** One color per kind, the same as the Media Library's Finals list. */
const KIND_BADGE: Record<FinalsKind, string> = {
  reel: "bg-red-600/90 text-white",
  carousel: "bg-sky-600/90 text-white",
  other: "bg-zinc-600/90 text-white",
};

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The tiles for the pieces. A piece's kind: a carousel is two or more images; a reel has a video winner; anything else
 * is other (an "ad" needs a stored kind, which pieces do not have yet). With `faceted` (a plug-in facet is picked) a
 * piece is kept only when one of its versions is among `cards`, the facet's result.
 */
export function finalsTiles(pieces: Piece[], cards: AssetCard[], faceted: boolean): FinalsTile[] {
  const byVersion = new Map(cards.map((c) => [c.versionId, c]));
  const out: FinalsTile[] = [];
  for (const piece of pieces) {
    const inCards = piece.items.map((i) => (i.versionId ? byVersion.get(i.versionId) : undefined));
    if (faceted && !inCards.some(Boolean)) continue;
    const win = piece.items.find((i) => i.winner) ?? piece.items[0];
    const card = win?.versionId ? byVersion.get(win.versionId) : undefined;
    const kind: FinalsKind =
      piece.items.length > 1 && inCards.every((c) => c?.kind === "image") ? "carousel" : card?.kind === "video" ? "reel" : "other";
    out.push({
      piece,
      kind,
      card,
      cover: piece.coverUrl ?? card?.thumbUrl ?? (win?.versionId ? `/api/library/media/${win.versionId}/thumb` : undefined),
      posted: piece.items.some((i) => i.postings.length > 0),
    });
  }
  return out;
}

/**
 * The Finals list: kind tiles (with counts), the plug-in facet bar, and the pieces as cards. Pure: the page passes
 * what it read; it draws nothing of its own store.
 */
export function FinalsView({
  hasFinals,
  pieces,
  cards,
  picked,
  onFacets,
  workshop = {},
}: {
  hasFinals: boolean;
  pieces: Piece[];
  cards: AssetCard[];
  picked: Record<string, string[]>;
  onFacets: (next: Record<string, string[]>) => void;
  /** Workshop sessions linked to pieces, by piece id: the Ready to post badge and the post description */
  workshop?: Record<string, WorkshopFinal>;
}) {
  const [kind, setKind] = useState<FinalsKind | null>(null);
  if (!hasFinals) return <p className="py-16 text-center text-sm text-zinc-500">Nothing in Finals yet.</p>;

  // Only the facets Finals shows narrow it: a Media Library facet (scope "library") never filters these pieces.
  const own = pickedFor(picked, "finals");
  const faceted = Object.values(own).some((v) => v.length > 0);
  const all = finalsTiles(pieces, cards, faceted);
  const shown = all.filter((t) => !kind || t.kind === kind);
  const kinds: (FinalsKind | null)[] = [null, "reel", "carousel", "other"];

  return (
    <>
      <div role="group" aria-label="Kind" className="flex gap-1.5 overflow-x-auto sm:grid sm:max-w-xl sm:grid-cols-4 sm:gap-3 sm:overflow-visible">
        {kinds.map((k) => {
          const Icon = k ? KIND_ICON[k] : LayoutGrid;
          const n = k ? all.filter((t) => t.kind === k).length : all.length;
          return (
            <button
              key={k ?? "all"}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={cn(
                "flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-left transition-colors sm:h-20 sm:flex-col sm:items-stretch sm:justify-between sm:rounded-xl sm:py-2.5",
                kind === k ? "border-violet-500 bg-violet-600/15" : "border-zinc-500/30 text-zinc-500 hover:border-zinc-400/60",
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-medium sm:text-sm">
                <Icon className="h-4 w-4 shrink-0" /> <span className="truncate">{k ? `${KIND_LABEL[k]}s` : "All"}</span>
              </span>
              <span className="text-xs font-semibold tabular-nums sm:text-2xl">{n}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <LibraryFacetBar facets={libraryFacets("finals")} value={picked} onChange={onFacets} />
      </div>

      {shown.length === 0 ? (
        <p className="py-16 text-center text-sm text-zinc-500">{faceted || kind ? "No pieces match." : "Nothing in Finals yet."}</p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 sm:gap-3 lg:grid-cols-5">
          {shown.map((t) => (
            <PieceCard key={t.piece.id} tile={t} work={workshop[t.piece.id]} />
          ))}
        </div>
      )}
    </>
  );
}

function PieceCard({ tile, work }: { tile: FinalsTile; work?: WorkshopFinal }) {
  const { piece, kind, card, cover, posted } = tile;
  const badges = card ? libraryBadges(card) : [];
  const versions = piece.items.length;
  const noun = kind === "carousel" ? "slide" : "version";
  // the winner's own post description, else the piece's (from the Workshop session it was made in)
  const winner = piece.items.find((i) => i.winner) ?? piece.items[0];
  const description = (winner && work?.versions[winner.id]?.text) || work?.description || "";
  return (
    <Link to={`/finals/${piece.id}`} className="block overflow-hidden rounded-xl border border-zinc-500/25 bg-zinc-500/5 transition-colors hover:border-zinc-400/60">
      <div className="relative aspect-[4/5] overflow-hidden bg-black">
        <ImageOff className="absolute inset-0 m-auto h-8 w-8 text-zinc-800" />
        {cover && (
          <img
            src={cover}
            alt=""
            draggable={false}
            loading="lazy"
            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
            onLoad={(e) => (e.currentTarget.style.visibility = "")}
            className="relative h-full w-full object-cover"
          />
        )}
        <div className="absolute left-1.5 top-1.5 flex flex-wrap gap-1 sm:left-2 sm:top-2">
          <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", KIND_BADGE[kind])}>{KIND_LABEL[kind]}</span>
          {work?.status === "toPost" && <span className="rounded bg-emerald-600/90 px-1.5 py-0.5 text-[11px] font-medium text-white">Ready to post</span>}
          {badges.map((b, i) => (
            <span key={i} className="rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">
              {b.label}
            </span>
          ))}
        </div>
        <span className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] text-white sm:bottom-2 sm:left-2">
          {versions} {versions === 1 ? noun : `${noun}s`}
        </span>
        {card?.durationS ? (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums text-white sm:bottom-2 sm:right-2">
            {clock(card.durationS)}
          </span>
        ) : null}
      </div>
      <div className="px-2 py-1.5 sm:px-3 sm:py-2.5">
        <p className="truncate text-xs font-medium sm:text-sm">{piece.label}</p>
        <p className="mt-0.5 truncate text-[10px] text-zinc-500 sm:text-xs">{posted ? "Posted" : "Not posted yet"}</p>
        {description && <p className="mt-1 line-clamp-2 text-[10px] text-zinc-400 sm:text-xs">{description}</p>}
      </div>
    </Link>
  );
}

/** /finals: reads the first library's Finals collection and its pieces, and the facet-filtered cards for their tiles. */
export default function FinalsPage() {
  const [libraries, setLibraries] = useState<LibrarySummary[] | null>(null);
  // undefined: not read yet; null: the library has no Finals collection (nothing is created on read)
  const [finals, setFinals] = useState<Collection | null | undefined>(undefined);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [cards, setCards] = useState<AssetCard[]>([]);
  const [workshop, setWorkshop] = useState<Record<string, WorkshopFinal>>({});
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  // the Finals trash: pieces taken out, listed until restored or gone for good (5 days)
  const [trashView, setTrashView] = useState(false);
  const [trashed, setTrashed] = useState<Piece[]>([]);
  const library = libraries?.[0] ?? null;
  const libId = library?.id;

  useEffect(() => {
    listLibraries().then(setLibraries, (e) => setError(message(e)));
  }, []);

  // a change anywhere in the library (a merge, a trash, a version added in Review) reads the lists again
  const [tick, setTick] = useState(0);
  useLibraryChanges(() => setTick((n) => n + 1));

  useEffect(() => {
    if (!libId) return;
    let live = true;
    listCollections(libId).then(
      (all) => live && setFinals(all.find(isFinals) ?? null),
      (e) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [libId]);

  useEffect(() => {
    if (!libId || !finals || !trashView) return;
    let live = true;
    listTrashedPieces(libId, finals.id).then(
      (p) => live && setTrashed(p),
      (e) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [libId, finals, trashView, tick]);

  useEffect(() => {
    if (!libId || !finals || trashView) return;
    let live = true;
    Promise.all([listPieces(libId, finals.id), listAllAssets(libId, pickedFor(picked, "finals")), getWorkshopFinals().catch((): Record<string, WorkshopFinal> => ({}))]).then(
      ([p, c, w]) => {
        if (!live) return;
        setPieces(p);
        setCards(c);
        setWorkshop(w);
        setError(null);
      },
      (e) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [libId, finals, picked, tick, trashView]);

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar tool="Finals" trail={library?.name} />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-4 sm:px-6">
        {error && <p className="text-sm text-red-500">{error}</p>}
        {libraries === null && !error && (
          <div className="flex justify-center py-16 text-zinc-500">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
        {libraries?.length === 0 && <p className="py-16 text-center text-sm text-zinc-500">No library yet. The workspace owner creates one.</p>}
        {library && finals === undefined && !error && (
          <div className="flex justify-center py-16 text-zinc-500">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
        {library && finals !== undefined && (
          <>
            <div className="flex gap-2">
              <Button size="sm" variant={trashView ? "outline" : "default"} aria-pressed={!trashView} onClick={() => setTrashView(false)}>
                Pieces
              </Button>
              <Button size="sm" variant={trashView ? "default" : "outline"} aria-pressed={trashView} onClick={() => setTrashView(true)}>
                Trash{trashView ? ` (${trashed.length})` : ""}
              </Button>
            </div>
            {trashView ? (
              <TrashList
                pieces={trashed}
                onRestore={(p) =>
                  void restorePiece(library.id, p.id)
                    .then(() => setTick((n) => n + 1))
                    .catch((e) => setError(message(e)))
                }
              />
            ) : (
              <FinalsView hasFinals={!!finals} pieces={pieces} cards={cards} picked={picked} onFacets={setPicked} workshop={workshop} />
            )}
          </>
        )}
      </main>
    </div>
  );
}

/** The Finals trash: each piece with its restore button. Gone for good 5 days after it went here. */
function TrashList({ pieces, onRestore }: { pieces: Piece[]; onRestore: (piece: Piece) => void }) {
  if (!pieces.length) return <p className="py-16 text-center text-sm text-zinc-500">The Finals trash is empty.</p>;
  return (
    <ul aria-label="Finals trash" className="flex flex-col divide-y divide-zinc-500/25 rounded-xl border border-zinc-500/25">
      {pieces.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <Link to={`/finals/${p.id}`} className="min-w-0 flex-1 truncate text-sm font-medium hover:underline">
            {p.label}
          </Link>
          <span className="text-xs text-zinc-500">
            {p.items.length} {p.items.length === 1 ? "version" : "versions"}
          </span>
          <Button size="sm" variant="outline" onClick={() => onRestore(p)}>
            <RotateCcw className="h-4 w-4" /> Restore
          </Button>
        </li>
      ))}
    </ul>
  );
}
