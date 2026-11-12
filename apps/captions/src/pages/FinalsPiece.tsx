import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { canUse, useMe } from "@/lib/auth";
import { ArrowDown, ArrowUp, Download, GripVertical, ImageOff, ImagePlus, Palette, Scissors, Trash2 } from "lucide-react";
import { createDesign } from "@/lib/designs";
import type { AssetCard, LibrarySummary, Piece, PieceItem } from "@contracts/library";
import { PLATFORMS } from "@contracts/connectors";
import { AppBar } from "@/components/AppBar";
import { Button } from "@/components/ui/button";
import {
  addPieceItem,
  addPosting,
  clearPieceCover,
  getPiece,
  getWorkshopFinals,
  isFinals,
  linkPieceToSession,
  listAllAssets,
  listCollections,
  listLibraries,
  listPieces,
  mergePiece,
  patchPieceItem,
  pieceZipUrl,
  removePieceItem,
  removePosting,
  renamePiece,
  reorderedPositions,
  setPieceCover,
  splitPieceItem,
  trashPiece,
  type WorkshopFinal,
} from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { createSession, listSessions, sessionPath, type SessionRow } from "@/lib/workshop";
import { finalsTiles } from "./FinalsPage";
import { confirmDialog } from "@/lib/dialogs";

/**
 * One piece of Finals (/finals/:pieceId): its versions in drag order, the winner (its frame is the cover on the list),
 * a post description and postings per version, and the versions that can still be added. Every change is a call to
 * the piece routes in api/library/collections.ts, so the piece lives in the library's own tables, the same as /library.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const thumbOf = (versionId: string | null, cards: Map<string, AssetCard>) =>
  (versionId && cards.get(versionId)?.thumbUrl) || (versionId ? `/api/library/media/${versionId}/thumb` : undefined);
const platformLabel = (id: string) => PLATFORMS.find((p) => p.id === id)?.label ?? id;

/** A text field that saves when it loses focus (and only when the text changed). */
function SavedText({
  value,
  label,
  disabled,
  multiline = false,
  placeholder,
  onSave,
}: {
  value: string;
  label: string;
  disabled: boolean;
  multiline?: boolean;
  placeholder?: string;
  onSave: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const common = {
    "aria-label": label,
    value: text,
    placeholder,
    disabled,
    onChange: (e: { target: { value: string } }) => setText(e.target.value),
    onBlur: () => {
      if (text !== value) onSave(text);
    },
    className: "w-full rounded-md border border-zinc-500/30 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-violet-500",
  };
  return multiline ? <textarea rows={2} {...common} /> : <input {...common} />;
}

function PostingForm({ disabled, onAdd }: { disabled: boolean; onAdd: (input: { platform: string; url?: string }) => void }) {
  const [platform, setPlatform] = useState<string>(PLATFORMS[0].id);
  const [url, setUrl] = useState("");
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd({ platform, url: url.trim() || undefined });
        setUrl("");
      }}
    >
      <select
        aria-label="Platform"
        value={platform}
        disabled={disabled}
        onChange={(e) => setPlatform(e.target.value)}
        className="rounded-md border border-zinc-500/30 bg-transparent px-2 py-1 text-sm"
      >
        {PLATFORMS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <input
        aria-label="Post link"
        placeholder="Link (optional)"
        value={url}
        disabled={disabled}
        onChange={(e) => setUrl(e.target.value)}
        className="min-w-0 flex-1 rounded-md border border-zinc-500/30 bg-transparent px-2 py-1 text-sm"
      />
      <Button type="submit" size="sm" variant="outline" disabled={disabled}>
        Add posting
      </Button>
    </form>
  );
}

/**
 * The piece's editor. It holds no copy of its own: each change calls the server and passes the piece it answers with
 * to `onPiece`. Drag order is a drag of the handle, or the up and down buttons (the same change, for touch and keyboard).
 */
export function PieceEditor({
  libraryId,
  piece,
  cards,
  readOnly = false,
  others = [],
  onPiece,
  onGone,
  onReload = () => {},
  onOpen = () => {},
  onOpenSession = () => {},
  onDesign,
  linked,
}: {
  /** Opens a design by its id (the designer, /design/:id); without it there is no "Design a cover". */
  onDesign?: (id: string) => void;
  libraryId: string;
  piece: Piece;
  cards: AssetCard[];
  /** Some item is not visible to the account: every control is off. */
  readOnly?: boolean;
  /** The other pieces of this Finals list (the merge picker). */
  others?: Piece[];
  onPiece: (next: Piece) => void;
  /** The piece left Finals (trashed): back to the list. */
  onGone: () => void;
  /** Another piece changed too (a merge took one away, a split made one): read the list again. */
  onReload?: () => void;
  onOpen?: (pieceId: string) => void;
  /** A Workshop session path to open (a session started from this piece). */
  onOpenSession?: (path: string) => void;
  /** The Workshop session this piece is linked to, when there is one (owner only; the library reads it). */
  linked?: WorkshopFinal;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [adding, setAdding] = useState("");
  const [pickId, setPickId] = useState<string | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  const locked = busy || readOnly;
  const byVersion = new Map(cards.filter((c) => c.versionId).map((c) => [c.versionId, c]));
  const available = cards.filter((c) => !c.trashedAt && !piece.items.some((i) => i.versionId === c.versionId));
  const kind = finalsTiles([piece], cards, false)[0]?.kind ?? "other";
  const cover = piece.items.find((i) => i.winner) ?? piece.items[0];
  // the version the cover is taken from: the one picked in the cover section, else the winner
  const pick = piece.items.find((i) => i.id === pickId && i.versionId) ?? cover;
  const pickVersion = pick?.versionId ?? null;
  const pickIsVideo = pickVersion ? byVersion.get(pickVersion)?.kind !== "image" : false;

  // Runs the calls one after another; only the last answer (the piece as the server holds it) is kept.
  /** A cover design from the frame the player is on: tall for an upright video, a wide thumbnail for a wide one. */
  const designCover = async () => {
    const v = player.current;
    if (!pickVersion) return;
    setBusy(true);
    setError(null);
    try {
      const d = await createDesign({ format: v && v.videoWidth > v.videoHeight ? "thumbnail" : "cover", version: pickVersion, t: v?.currentTime ?? 0, title: piece.label });
      onDesign?.(d.id);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const run = async (calls: (() => Promise<Piece>)[]) => {
    setBusy(true);
    setError(null);
    try {
      let last: Piece | undefined;
      for (const call of calls) last = await call();
      if (last) onPiece(last);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const itemCall = (item: PieceItem, patch: Parameters<typeof patchPieceItem>[3]) => () =>
    patchPieceItem(libraryId, piece.id, item.id, patch);

  const moveTo = (from: number, to: number) => {
    const changes = reorderedPositions(piece.items, from, to);
    if (changes.length) void run(changes.map((c) => () => patchPieceItem(libraryId, piece.id, c.id, { position: c.position })));
  };

  const rename = (label: string) => {
    if (label.trim() && label.trim() !== piece.label) void run([() => renamePiece(libraryId, piece.id, label.trim())]);
  };

  const trash = async () => {
    if (!(await confirmDialog({ title: "Move this piece to the Finals trash?", body: "Its versions stay in the library. It is gone for good after 5 days.", ok: "Move to trash", danger: true, deleting: true }))) return;
    setBusy(true);
    setError(null);
    try {
      await trashPiece(libraryId, piece.id);
      onGone();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  // Joins another piece of this list into this one (its versions move; a version both hold is refused by the server).
  const mergeIn = async (fromId: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await mergePiece(libraryId, piece.id, fromId);
      onPiece(next);
      onReload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  // An item becomes a piece of its own (its postings go with it); this page then opens that new piece.
  const split = async (item: PieceItem) => {
    setBusy(true);
    setError(null);
    try {
      const made = await splitPieceItem(libraryId, piece.id, item.id);
      onOpen(made.id);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <SavedText value={piece.label} label="Piece name" disabled={locked} onSave={rename} />
          <p className="mt-1 text-xs text-zinc-500">
            {kind === "reel" ? "Reel" : kind === "carousel" ? "Carousel" : "Other"} · {piece.items.length}{" "}
            {piece.items.length === 1 ? "version" : "versions"}
          </p>
        </div>
        {piece.items.length > 0 && (
          <Button asChild variant="outline" size="sm">
            <a href={pieceZipUrl(libraryId, piece.id)} download>
              <Download className="h-4 w-4" /> Save all as ZIP
            </a>
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={locked} onClick={trash}>
          <Trash2 className="h-4 w-4" /> Move to trash
        </Button>
      </div>

      {readOnly && <p className="text-sm text-zinc-500">Read only: some versions in this piece are not visible to your account.</p>}

      {!readOnly && others.length > 0 && (
        <select
          aria-label="Merge another piece into this one"
          value=""
          disabled={locked}
          onChange={(e) => e.target.value && void mergeIn(e.target.value)}
          className="min-w-0 max-w-full rounded-md border border-zinc-500/30 bg-transparent px-2 py-1.5 text-sm sm:max-w-md"
        >
          <option value="">Merge another piece into this one…</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label} · {o.items.length} {o.items.length === 1 ? "version" : "versions"}
            </option>
          ))}
        </select>
      )}

      <section aria-label="Cover" className="flex flex-col gap-2 sm:max-w-xs">
        <div className="relative aspect-[4/5] overflow-hidden rounded-xl bg-black">
          <ImageOff className="absolute inset-0 m-auto h-8 w-8 text-zinc-800" />
          {(piece.coverUrl || cover?.versionId) && (
            <img
              src={piece.coverUrl ?? thumbOf(cover?.versionId ?? null, byVersion)}
              alt=""
              draggable={false}
              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
              className="relative h-full w-full object-cover"
            />
          )}
        </div>
        <p className="text-xs text-zinc-500">
          {piece.coverUrl ? "A frame you picked is the cover on the Finals list." : "The winner's frame is the cover on the Finals list until you pick one."}
        </p>
        {!readOnly && pickVersion && (
          <div className="flex flex-col gap-2">
            <select
              aria-label="Version to take the cover from"
              value={pick?.id ?? ""}
              disabled={locked}
              onChange={(e) => setPickId(e.target.value)}
              className="min-w-0 rounded-md border border-zinc-500/30 bg-transparent px-2 py-1.5 text-sm"
            >
              {piece.items
                .filter((i) => i.versionId)
                .map((i, n) => (
                  <option key={i.id} value={i.id}>
                    {i.label ?? (i.versionId && byVersion.get(i.versionId)?.title) ?? `Version ${n + 1}`}
                  </option>
                ))}
            </select>
            {pickIsVideo ? (
              <video
                key={pickVersion}
                ref={player}
                src={`/api/library/media/${pickVersion}/play`}
                controls
                playsInline
                preload="metadata"
                className="max-h-64 w-full rounded-md bg-black"
              />
            ) : (
              <img key={pickVersion} src={`/api/library/media/${pickVersion}/play`} alt="" className="max-h-64 w-full rounded-md bg-black object-contain" />
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={locked}
                onClick={() => void run([() => setPieceCover(libraryId, piece.id, pickVersion, pickIsVideo ? (player.current?.currentTime ?? 0) : 0)])}
              >
                <ImagePlus className="h-4 w-4" /> {pickIsVideo ? "Use this frame as cover" : "Use this picture as cover"}
              </Button>
              {pickIsVideo && onDesign && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void designCover()}>
                  <Palette className="h-4 w-4" /> Design a cover from this frame
                </Button>
              )}
              {piece.coverUrl && (
                <Button size="sm" variant="ghost" disabled={locked} onClick={() => void run([() => clearPieceCover(libraryId, piece.id)])}>
                  Back to the automatic cover
                </Button>
              )}
            </div>
          </div>
        )}
      </section>

      <ol aria-label="Versions" className="flex flex-col gap-3">
        {piece.items.length === 0 && <li className="text-sm text-zinc-500">No versions yet. Add one below.</li>}
        {piece.items.map((item, i) => {
          const card = item.versionId ? byVersion.get(item.versionId) : undefined;
          return (
            <li
              key={item.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom !== null && !locked) moveTo(dragFrom, i);
                setDragFrom(null);
              }}
              className="flex flex-col gap-2 rounded-xl border border-zinc-500/25 bg-zinc-500/5 p-2.5 sm:flex-row"
            >
              <div className="flex items-start gap-2 sm:w-64 sm:shrink-0">
                <span
                  draggable={!locked}
                  onDragStart={() => setDragFrom(i)}
                  onDragEnd={() => setDragFrom(null)}
                  aria-label={`Drag ${item.label ?? card?.title ?? "version"}`}
                  className="mt-1 cursor-grab text-zinc-500"
                >
                  <GripVertical className="h-4 w-4" />
                </span>
                <div className="relative h-20 w-16 shrink-0 overflow-hidden rounded-md bg-black">
                  {item.versionId && (
                    <img
                      src={thumbOf(item.versionId, byVersion)}
                      alt=""
                      draggable={false}
                      loading="lazy"
                      onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                      className="h-full w-full object-cover"
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <SavedText
                    value={item.label ?? ""}
                    label={`Version ${i + 1} name`}
                    placeholder={card?.title ?? "Version name"}
                    disabled={locked}
                    onSave={(text) => void run([itemCall(item, { label: text.trim() || null })])}
                  />
                  <p className="mt-1 truncate text-xs text-zinc-500">{card ? `${card.title} · v${card.versionN}` : "Not in the library any more"}</p>
                </div>
              </div>

              <div className="flex flex-1 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    variant={item.winner ? "default" : "outline"}
                    aria-pressed={item.winner}
                    disabled={locked}
                    onClick={() => void run([itemCall(item, { winner: !item.winner })])}
                  >
                    {item.winner ? "Winner (cover)" : "Make winner"}
                  </Button>
                  <Button size="sm" variant="ghost" aria-label="Move up" disabled={locked || i === 0} onClick={() => moveTo(i, i - 1)}>
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Move down"
                    disabled={locked || i === piece.items.length - 1}
                    onClick={() => moveTo(i, i + 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={locked}
                    onClick={() => void run([() => removePieceItem(libraryId, piece.id, item.id)])}
                  >
                    Remove from piece
                  </Button>
                  <Button size="sm" variant="ghost" disabled={locked} onClick={() => void split(item)}>
                    <Scissors className="h-4 w-4" /> Make its own piece
                  </Button>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs text-zinc-500">Post description</span>
                  <SavedText
                    multiline
                    value={item.postDescription ?? ""}
                    label={`Post description for version ${i + 1}`}
                    placeholder="The text under the post"
                    disabled={locked}
                    onSave={(text) => void run([itemCall(item, { postDescription: text.trim() })])}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-zinc-500">Posted to</span>
                  {item.postings.length === 0 && <span className="text-xs text-zinc-500">Not posted yet</span>}
                  {item.postings.map((p) => (
                    <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <span>{platformLabel(p.platform)}</span>
                      {p.url && (
                        <a href={p.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-violet-500 underline">
                          {p.url}
                        </a>
                      )}
                      <span className="text-xs text-zinc-500">{new Date(p.postedAt).toLocaleDateString()}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove posting on ${platformLabel(p.platform)}`}
                        disabled={locked}
                        onClick={() => void run([() => removePosting(libraryId, piece.id, item.id, p.id)])}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  <PostingForm disabled={locked} onAdd={(input) => void run([() => addPosting(libraryId, piece.id, item.id, input)])} />
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!adding) return;
          void run([() => addPieceItem(libraryId, piece.id, adding)]);
          setAdding("");
        }}
      >
        <select
          aria-label="Version to add"
          value={adding}
          disabled={locked || available.length === 0}
          onChange={(e) => setAdding(e.target.value)}
          className="min-w-0 max-w-full flex-1 rounded-md border border-zinc-500/30 bg-transparent px-2 py-1.5 text-sm sm:max-w-md"
        >
          <option value="">{available.length ? "Add a version from the library" : "Every version in the library is in this piece"}</option>
          {available.map((c) => (
            <option key={c.id} value={c.versionId}>
              {c.title} · v{c.versionN}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" variant="outline" disabled={locked || !adding}>
          Add to piece
        </Button>
      </form>

      <WorkshopLink piece={piece} disabled={locked} onOpenSession={onOpenSession} linked={linked} />
    </div>
  );
}

/** Link this piece to a Workshop session (its versions then get a post description each there), or start a session from it. */
function WorkshopLink({
  piece,
  disabled,
  onOpenSession,
  linked,
}: {
  piece: Piece;
  disabled: boolean;
  onOpenSession: (path: string) => void;
  linked?: WorkshopFinal;
}) {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [pick, setPick] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listSessions().then(
      (all) => live && setSessions(all),
      (e) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  const link = async (sessionId: string) => {
    setError(null);
    setNote(null);
    try {
      await linkPieceToSession(sessionId, piece.id);
      setNote("Linked. Each version of this piece gets a post description in that session.");
    } catch (e) {
      setError(message(e));
    }
  };

  const startNew = async () => {
    setError(null);
    try {
      const made = await createSession({ title: piece.label });
      await linkPieceToSession(made.id, piece.id);
      onOpenSession(sessionPath(made.id));
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <section aria-label="Workshop session" className="flex flex-col gap-2 border-t border-zinc-500/25 pt-4">
      <h2 className="text-sm font-medium">Workshop session</h2>
      {linked && (
        <Link to={sessionPath(linked.sessionId)} className="text-xs text-zinc-400 hover:text-zinc-200">
          {linked.status === "toPost" ? "Ready to post · " : ""}Open the linked session →
        </Link>
      )}
      <p className="text-xs text-zinc-500">Link a session, and each version here gets a post description there.</p>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Session to link"
          value={pick}
          disabled={disabled || !sessions?.length}
          onChange={(e) => setPick(e.target.value)}
          className="min-w-0 max-w-full rounded-md border border-zinc-500/30 bg-transparent px-2 py-1.5 text-sm sm:max-w-md"
        >
          <option value="">{sessions ? (sessions.length ? "Choose a session" : "No sessions yet") : "Loading sessions…"}</option>
          {(sessions ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" disabled={disabled || !pick} onClick={() => void link(pick)}>
          Link session
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void startNew()}>
          Start a session from this piece
        </Button>
      </div>
      {note && <p className="text-xs text-zinc-500">{note}</p>}
      {error && <p className="text-sm text-red-500">{error}</p>}
    </section>
  );
}

type PieceView = {
  found: { library: LibrarySummary; piece: Piece } | null;
  cards: AssetCard[];
  others: Piece[];
  workshop: Record<string, WorkshopFinal>;
};

/** The piece in the first library that has it, its library's cards and the other Finals pieces, and its Workshop link. */
async function loadPieceView(pieceId: string): Promise<PieceView> {
  // the Workshop session this piece is linked to (owner only; an empty answer when it is not)
  const workshop = getWorkshopFinals().catch((): Record<string, WorkshopFinal> => ({}));
  const all = await listLibraries();
  // a library the account cannot see the piece in answers 404: that library is skipped
  const hits = await Promise.all(all.map((library) => getPiece(library.id, pieceId).then((piece) => ({ library, piece }), () => null)));
  const found = hits.find((h): h is { library: LibrarySummary; piece: Piece } => h !== null) ?? null;
  if (!found) return { found, cards: [], others: [], workshop: await workshop };
  // the cards come with it: the versions would otherwise read "Not in the library any more" until they arrive
  const [cards, collections] = await Promise.all([listAllAssets(found.library.id), listCollections(found.library.id)]);
  const finals = collections.find(isFinals);
  const siblings = finals ? await listPieces(found.library.id, finals.id) : [];
  return { found, cards, others: siblings.filter((p) => p.id !== pieceId), workshop: await workshop };
}

/**
 * /finals/:pieceId: the piece in whichever library the account can read (the first that answers, with its Finals or not).
 * A piece's cards come from its library's list, for the thumbnails and the add-a-version picker. Reads again when the
 * library changes (a merge or a trash elsewhere, a version added from Review).
 */
export default function FinalsPiecePage() {
  const { pieceId = "" } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  // the saved copy paints at once; the change stream's library topic reads it again (lib/local-cache)
  const view = useCachedLoad<PieceView>(`/api/library/finals-piece/${pieceId}`, () => loadPieceView(pieceId));
  const found = view.data ? view.data.found : undefined;
  const cards = view.data?.cards ?? [];
  const others = view.data?.others ?? [];
  const workshop = view.data?.workshop ?? {};
  const error = view.data ? null : view.error || null;
  const reload = () => void view.refresh().catch(() => {});
  const setFound = (next: { library: LibrarySummary; piece: Piece }) => view.set((v) => v && { ...v, found: next });

  const library = found?.library ?? null;
  const piece = found?.piece;

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar tool="Finals" trail={library?.name} />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-4 py-4 sm:px-6">
        <Link to="/finals" className="text-sm text-zinc-500 hover:text-zinc-300">
          ← Finals
        </Link>
        {error && <p className="text-sm text-red-500">{error}</p>}
        {found === undefined && !error && <div aria-hidden="true" className="h-[420px] rounded-xl bg-zinc-500/5" />}
        {found === null && <p className="py-16 text-center text-sm text-zinc-500">No such piece in Finals.</p>}
        {library && piece && (
          <PieceEditor
            onDesign={canUse(me, "design") ? (design) => navigate(`/design/${design}`) : undefined}
            key={piece.id}
            libraryId={library.id}
            piece={piece}
            cards={cards}
            others={others}
            readOnly={!piece.writable}
            onPiece={(next) => setFound({ library, piece: { ...next, writable: piece.writable } })}
            onGone={() => navigate("/finals")}
            onReload={reload}
            onOpen={(id) => navigate(`/finals/${id}`)}
            onOpenSession={(path) => navigate(path)}
            linked={workshop[pieceId]}
          />
        )}
      </main>
    </div>
  );
}
