import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { canUse, useMe } from "@/lib/auth";
import { ArrowDown, ArrowUp, Download, GripVertical, ImageOff, ImagePlus, Link2, Merge, MoreHorizontal, NotebookPen, Palette, Plus, Scissors, Send, Share2, Star, Trash2, Upload, X, type LucideIcon } from "lucide-react";
import { ClipShare } from "./library/ClipShare";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { createDesign } from "@/lib/designs";
import { useWorkspace } from "@/lib/workspace";
import type { AssetCard, LibrarySummary, Piece, PieceItem } from "@contracts/library";
import { PLATFORMS } from "@contracts/connectors";
import { Button } from "@/components/ui/button";
import {
  addPieceItem,
  addPosting,
  getAsset,
  uploadFile,
  clearPieceCover,
  getPiece,
  getWorkshopFinals,
  isFinals,
  linkPieceToSession,
  cardsOfVersions,
  listCollections,
  listLibraries,
  listPieces,
  pieceVersions,
  mergePiece,
  restorePiece,
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
import { finalsTiles, KIND_BADGE, KIND_LABEL } from "./FinalsPage";
import { confirmDialog } from "@/lib/dialogs";
import { undoable } from "@/lib/undo";
import { localOf } from "@/lib/here";
import { usePlayFrom } from "@/lib/play-here";

/**
 * One piece of Finals (/finals/:pieceId): its versions in drag order, the winner (its frame is the cover on the list),
 * a post description and postings per version, and the versions that can still be added. Every change is a call to
 * the piece routes in api/library/collections.ts, so the piece lives in the library's own tables, the same as /library.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const thumbOf = (versionId: string | null, cards: Map<string, AssetCard>) =>
  (versionId && cards.get(versionId)?.thumbUrl) || (versionId ? `/api/library/media/${versionId}/thumb` : undefined);
const platformLabel = (id: string) => PLATFORMS.find((p) => p.id === id)?.label ?? id;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** A text field that saves when it loses focus (and only when the text changed). */
function SavedText({
  value,
  label,
  disabled,
  multiline = false,
  placeholder,
  className = "w-full rounded-md border border-zinc-500/30 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-violet-500",
  onSave,
}: {
  className?: string;
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
    className,
  };
  return multiline ? <textarea rows={5} {...common} className={cn(className, "resize-y")} /> : <input {...common} />;
}

/** The platform a post link is on, by its address; undefined for any other site. */
export function platformOfLink(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url.trim()).hostname.replace(/^(www|m)\./, "");
  } catch {
    return undefined;
  }
  const on = (d: string) => host === d || host.endsWith(`.${d}`);
  if (on("instagram.com")) return "instagram";
  if (on("facebook.com") || on("fb.watch")) return "facebook";
  if (on("youtube.com") || on("youtu.be")) return "youtube";
  if (on("tiktok.com")) return "tiktok";
  if (on("x.com") || on("twitter.com")) return "x";
  return undefined;
}

/**
 * Files as new versions of a piece, one after another: each uploaded into the library (the piece's collection, Finals),
 * its clip's version then added to the piece, last. The piece as the server holds it after the last one; a file that
 * gives no clip stops there with an error, and the files after it are not sent.
 */
export async function uploadVersions(libraryId: string, piece: Piece, files: File[], onProgress: (file: File, sent: number) => void): Promise<Piece | undefined> {
  let next: Piece | undefined;
  for (const f of files) {
    onProgress(f, 0);
    const up = await uploadFile(libraryId, f, (sent) => onProgress(f, sent), piece.collectionId ?? undefined);
    const assetId = up.assetId ?? up.duplicateOf;
    if (!assetId) throw new Error(`Could not upload ${f.name}`);
    next = await addPieceItem(libraryId, piece.id, (await getAsset(libraryId, assetId)).versionId);
  }
  return next;
}

/** One row of the post panel: icon, title, its state, its actions; what it opens goes under it. Posts and the
 *  Content Workshop share it, so the two read alike. */
function Card({ icon: Icon, title, status, actions, children }: { icon: LucideIcon; title: string; status: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-lg border border-zinc-500/25">
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <Icon className="h-4 w-4 shrink-0 text-zinc-500" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm">{title}</span>
          <span className="block truncate text-xs text-zinc-500">{status}</span>
        </span>
        {actions}
      </div>
      {children && <div className="flex flex-col gap-2 border-t border-zinc-500/15 px-3 py-2.5">{children}</div>}
    </section>
  );
}

/** A post link: pasted, its platform picked from the address (changeable for a short link). */
export function PostingForm({ onAdd, onCancel }: { onAdd: (input: { platform: string; url?: string }) => void; onCancel: () => void }) {
  const [platform, setPlatform] = useState<string>(PLATFORMS[0].id);
  const [url, setUrl] = useState("");
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd({ platform, url: url.trim() || undefined });
      }}
    >
      <input
        aria-label="Post link"
        autoFocus
        type="url"
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          const found = platformOfLink(e.target.value);
          if (found) setPlatform(found);
        }}
        className="min-w-0 flex-1 basis-48 rounded-md border border-zinc-500/30 bg-transparent px-2 py-1 text-sm outline-none focus:border-violet-500"
      />
      <select
        aria-label="Platform"
        value={platform}
        onChange={(e) => setPlatform(e.target.value)}
        className="rounded-md border border-zinc-500/30 bg-transparent px-2 py-1 text-sm"
      >
        {PLATFORMS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" variant="outline">
        Add
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

/**
 * The piece's editor. It holds no copy of its own: each change calls the server and passes the piece it answers with
 * to `onPiece`. Drag order is a drag of the handle, or Move up and Move down in the row's menu (the same change, for touch and keyboard).
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
  const [pickId, setPickId] = useState<string | null>(null);
  const [posting, setPosting] = useState(false); // the post link form is open
  const [upload, setUpload] = useState<{ name: string; pct: number } | null>(null);
  const [sharing, setSharing] = useState<{ kind: "piece" | "version"; id: string; title: string } | null>(null);
  const files = useRef<HTMLInputElement>(null);
  const player = useRef<HTMLVideoElement>(null);
  const locked = busy || readOnly;
  const byVersion = new Map(cards.filter((c) => c.versionId).map((c) => [c.versionId, c]));
  const kind = finalsTiles([piece], cards, false)[0]?.kind ?? "other";
  const cover = piece.items.find((i) => i.winner) ?? piece.items[0];
  // the version on show (the player, its post): the one picked in the list, else the winner
  const pick = piece.items.find((i) => i.id === pickId) ?? cover;
  const pickVersion = pick?.versionId ?? null;
  const pickIsVideo = pickVersion ? byVersion.get(pickVersion)?.kind !== "image" : false;
  // a video this computer has plays from it (lib/play-here.ts): its original or cached proxy, as the library's player
  const play = usePlayFrom(`/api/library/media/${pickVersion}/play`, pickVersion && pickIsVideo ? () => localOf(libraryId, pickVersion) : undefined);

  // Runs the calls one after another; only the last answer (the piece as the server holds it) is kept.
  /** A cover design from the frame the player is on: tall for an upright video, a wide thumbnail for a wide one. */
  const designCover = async () => {
    const v = player.current;
    if (!pickVersion) return;
    setBusy(true);
    setError(null);
    try {
      // in the brand project this window is in
      const d = await createDesign({ format: v && v.videoWidth > v.videoHeight ? "thumbnail" : "cover", version: pickVersion, t: v?.currentTime ?? 0, title: piece.label, project: useWorkspace.getState().currentProjectId ?? undefined });
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
    if (!(await confirmDialog({ title: "Move this piece to the Finals trash?", body: "Its versions stay in the Media Library; the piece is deleted after 5 days.", ok: "Move to trash", danger: true, deleting: true }))) return;
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
      // onReload reads the open piece again, whichever is open by then
      undoable("pieces merged", () => restorePiece(libraryId, fromId).then(onReload, (e: unknown) => setError(message(e))));
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

  // New versions from files (uploadVersions); the last one added is shown
  const addFiles = async (picked: File[]) => {
    if (locked || !picked.length) return;
    setBusy(true);
    setError(null);
    try {
      const next = await uploadVersions(libraryId, piece, picked, (f, sent) =>
        setUpload({ name: f.name, pct: f.size ? Math.min(100, Math.round((sent / f.size) * 100)) : 0 }),
      );
      if (next) {
        onPiece(next);
        setPickId(next.items[next.items.length - 1]?.id ?? null);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setUpload(null);
      setBusy(false);
    }
  };

  const versionName = (item: PieceItem, n: number) => item.label ?? (item.versionId && byVersion.get(item.versionId)?.title) ?? `Version ${n + 1}`;
  const posted = piece.items.some((i) => i.postings.length > 0);
  const many = piece.items.length > 1;
  const selIndex = pick ? piece.items.indexOf(pick) : -1;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        void addFiles([...e.dataTransfer.files]);
      }}
    >
      <header className="flex items-start gap-2 border-b border-zinc-500/25 py-3 pl-4 pr-12 sm:pl-5">
        <div className="min-w-0 flex-1">
          <SavedText
            value={piece.label}
            label="Piece name"
            disabled={locked}
            onSave={rename}
            className="w-full truncate rounded-md border border-transparent bg-transparent px-1.5 py-0.5 -ml-1.5 text-base font-semibold outline-none hover:border-zinc-500/30 focus:border-violet-500 disabled:hover:border-transparent"
          />
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
            <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", KIND_BADGE[kind])}>{KIND_LABEL[kind]}</span>
            {piece.items.length} {piece.items.length === 1 ? "version" : "versions"} · {posted ? "Posted" : "Not posted"}
          </p>
        </div>
        {piece.items.length > 0 && (
          <Button asChild variant="outline" size="sm">
            <a href={pieceZipUrl(libraryId, piece.id)} download>
              <Download className="h-4 w-4" /> Download
            </a>
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={readOnly} onClick={() => setSharing({ kind: "piece", id: piece.id, title: piece.label })}>
          <Share2 className="h-4 w-4" /> Share
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" aria-label="Piece menu" disabled={locked}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {others.length > 0 && (
              <>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Merge className="h-4 w-4" /> Merge piece
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                    {others.map((o) => (
                      <DropdownMenuItem key={o.id} onSelect={() => void mergeIn(o.id)}>
                        <span className="min-w-0 flex-1 truncate">{o.label}</span>
                        <span className="text-xs text-zinc-500">{o.items.length}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem variant="destructive" onSelect={() => void trash()}>
              <Trash2 className="h-4 w-4" /> Move to trash
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[minmax(0,300px)_1fr]">
        <section aria-label="Cover" className="flex flex-col gap-3 border-b border-zinc-500/25 p-4 sm:p-5 md:border-b-0 md:border-r">
          {pickVersion ? (
            pickIsVideo ? (
              <video
                key={pickVersion}
                ref={player}
                src={play.src}
                onError={play.onError}
                controls
                playsInline
                preload="metadata"
                className="mx-auto aspect-[9/16] max-h-[55dvh] w-full rounded-lg bg-black object-contain"
              />
            ) : (
              <img key={pickVersion} src={`/api/library/media/${pickVersion}/play`} alt="" className="mx-auto aspect-[9/16] max-h-[55dvh] w-full rounded-lg bg-black object-contain" />
            )
          ) : (
            <div className="flex aspect-[9/16] max-h-[55dvh] w-full items-center justify-center rounded-lg bg-black">
              <ImageOff className="h-8 w-8 text-zinc-800" />
            </div>
          )}

          <div className="flex items-center gap-3 rounded-lg border border-zinc-500/25 p-2">
            <span className="relative block h-12 w-10 shrink-0 overflow-hidden rounded bg-black">
              {(piece.coverUrl || cover?.versionId) && (
                <img
                  src={piece.coverUrl ?? thumbOf(cover?.versionId ?? null, byVersion)}
                  alt=""
                  draggable={false}
                  onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                  className="h-full w-full object-cover"
                />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm">Cover</span>
              <span className="block truncate text-xs text-zinc-500">{piece.coverWaits ?? (piece.coverUrl ? "Picked frame" : "Winner's frame")}</span>
            </span>
            {piece.coverUrl && !readOnly && (
              <Button size="sm" variant="ghost" disabled={locked} onClick={() => void run([() => clearPieceCover(libraryId, piece.id)])}>
                Reset cover
              </Button>
            )}
          </div>
          {!readOnly && pickVersion && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={locked}
                onClick={() => void run([() => setPieceCover(libraryId, piece.id, pickVersion, pickIsVideo ? (player.current?.currentTime ?? 0) : 0)])}
              >
                <ImagePlus className="h-4 w-4" /> {pickIsVideo ? "Use frame as cover" : "Use as cover"}
              </Button>
              {pickIsVideo && onDesign && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void designCover()}>
                  <Palette className="h-4 w-4" /> Design cover
                </Button>
              )}
            </div>
          )}
        </section>

        <div className="flex min-w-0 flex-col gap-5 p-4 sm:p-5">
          {error && <p className="text-sm text-red-500">{error}</p>}
          {readOnly && <p className="text-sm text-zinc-500">Read only: some versions in this piece are not visible to this account.</p>}

          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">
              {upload ? `Uploading ${upload.name} · ${upload.pct}%` : piece.items.length === 0 ? "No versions" : many ? "Versions" : ""}
            </span>
            <input
              ref={files}
              type="file"
              multiple
              accept="video/*,image/*"
              hidden
              disabled={locked}
              onChange={(e) => {
                void addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <Button size="sm" variant="ghost" disabled={locked} onClick={() => files.current?.click()}>
              <Upload className="h-4 w-4" /> Add version
            </Button>
          </div>
          {many && (
            <ol aria-label="Versions" className="flex flex-col gap-1">
              {piece.items.map((item, i) => {
                const card = item.versionId ? byVersion.get(item.versionId) : undefined;
                const name = versionName(item, i);
                const selected = item === pick;
                return (
                  <li
                    key={item.id}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragFrom !== null && !locked) moveTo(dragFrom, i);
                      setDragFrom(null);
                    }}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border px-1.5 py-1 transition-colors",
                      selected ? "border-violet-500 bg-violet-600/10" : "border-transparent hover:bg-zinc-500/10",
                    )}
                  >
                    <span
                      draggable={!locked}
                      onDragStart={() => setDragFrom(i)}
                      onDragEnd={() => setDragFrom(null)}
                      aria-label={`Drag ${name}`}
                      className={cn("text-zinc-600", !locked && "cursor-grab")}
                    >
                      <GripVertical className="h-4 w-4" />
                    </span>
                    <button
                      type="button"
                      data-pick=""
                      aria-current={selected || undefined}
                      onClick={() => setPickId(item.id)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      <span className="relative block h-11 w-8 shrink-0 overflow-hidden rounded bg-black">
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
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{name}</span>
                        <span className="block truncate text-xs text-zinc-500">
                          {card ? `v${card.versionN}${card.durationS ? ` · ${clock(card.durationS)}` : ""}` : "Not in the Media Library"}
                          {item.postings.length > 0 ? " · Posted" : ""}
                        </span>
                      </span>
                    </button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={item.winner ? `${name} is the winner` : `Make ${name} the winner`}
                      title={item.winner ? "Winner" : "Make winner"}
                      aria-pressed={item.winner}
                      disabled={locked}
                      onClick={() => void run([itemCall(item, { winner: !item.winner })])}
                    >
                      <Star className={cn("h-4 w-4", item.winner ? "fill-amber-400 text-amber-400" : "text-zinc-600")} />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="ghost" aria-label={`${name} menu`} disabled={locked}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem disabled={i === 0} onSelect={() => moveTo(i, i - 1)}>
                          <ArrowUp className="h-4 w-4" /> Move up
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={i === piece.items.length - 1} onSelect={() => moveTo(i, i + 1)}>
                          <ArrowDown className="h-4 w-4" /> Move down
                        </DropdownMenuItem>
                        {item.versionId && (
                          <DropdownMenuItem onSelect={() => setSharing({ kind: "version", id: item.versionId!, title: name })}>
                            <Share2 className="h-4 w-4" /> Share version
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => void split(item)}>
                          <Scissors className="h-4 w-4" /> Make its own piece
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => void run([() => removePieceItem(libraryId, piece.id, item.id)])}>
                          <X className="h-4 w-4" /> Remove from piece
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
            </ol>
          )}

          {pick && (
            <section aria-label="Post" key={pick.id} className="flex flex-col gap-4">
              {many && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-zinc-500">Version name</span>
                  <SavedText
                    value={pick.label ?? ""}
                    label={`Version ${selIndex + 1} name`}
                    placeholder={(pick.versionId && byVersion.get(pick.versionId)?.title) || "Version name"}
                    disabled={locked}
                    onSave={(text) => void run([itemCall(pick, { label: text.trim() || null })])}
                  />
                </label>
              )}
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-500">Post description</span>
                <SavedText
                  multiline
                  value={pick.postDescription ?? ""}
                  label={`Post description for version ${selIndex + 1}`}
                  disabled={locked}
                  onSave={(text) => void run([itemCall(pick, { postDescription: text.trim() })])}
                />
              </label>
              <Card
                icon={Send}
                title="Posts"
                status={pick.postings.length ? `Posted on ${[...new Set(pick.postings.map((p) => platformLabel(p.platform)))].join(", ")}` : "Not posted"}
                actions={
                  !posting && (
                    <Button size="sm" variant="outline" disabled={locked} onClick={() => setPosting(true)}>
                      <Link2 className="h-4 w-4" /> Add link
                    </Button>
                  )
                }
              >
                {(pick.postings.length > 0 || posting) && (
                  <>
                    {pick.postings.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 text-sm">
                        <span className="shrink-0">{platformLabel(p.platform)}</span>
                        {p.url ? (
                          <a href={p.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-zinc-400 hover:text-zinc-200 hover:underline">
                            {p.url.replace(/^https?:\/\/(www\.)?/, "")}
                          </a>
                        ) : (
                          <span className="flex-1" />
                        )}
                        <span className="shrink-0 text-xs text-zinc-500">{new Date(p.postedAt).toLocaleDateString()}</span>
                        <button
                          type="button"
                          aria-label={`Remove posting on ${platformLabel(p.platform)}`}
                          disabled={locked}
                          onClick={() => void run([() => removePosting(libraryId, piece.id, pick.id, p.id)])}
                          className="shrink-0 rounded p-1 text-zinc-500 hover:text-zinc-200"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                    {posting && (
                      <PostingForm
                        onCancel={() => setPosting(false)}
                        onAdd={(input) => {
                          setPosting(false);
                          void run([() => addPosting(libraryId, piece.id, pick.id, input)]);
                        }}
                      />
                    )}
                  </>
                )}
              </Card>
            </section>
          )}

          <WorkshopLink piece={piece} disabled={locked} onOpenSession={onOpenSession} onLinked={onReload} linked={linked} />
        </div>
      </div>
      {sharing && (
        <ClipShare
          libraryId={libraryId}
          assetId=""
          versionId=""
          target={{ kind: sharing.kind, id: sharing.id }}
          href={`/finals/${piece.id}`}
          title={sharing.title}
          open
          onOpenChange={(o) => !o && setSharing(null)}
        />
      )}
    </div>
  );
}

/** Link this piece to a Workshop session (its versions then get a post description each there), or start a session from it. */
function WorkshopLink({
  piece,
  disabled,
  onOpenSession,
  onLinked,
  linked,
}: {
  piece: Piece;
  disabled: boolean;
  onOpenSession: (path: string) => void;
  /** A link was made: the page reads the piece's link again, so the row offers Open project. */
  onLinked: () => void;
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
      setNote("Linked");
      onLinked();
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

  const [choosing, setChoosing] = useState(false);
  return (
    <Card
      icon={NotebookPen}
      title="Content Workshop"
      status={linked ? (linked.status === "toPost" ? "Ready to post" : "Linked") : (note ?? "Not linked")}
      actions={
        linked ? (
          <Button asChild size="sm" variant="outline">
            <Link to={sessionPath(linked.sessionId)}>Open project</Link>
          </Button>
        ) : (
          !choosing && (
            <>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => setChoosing(true)}>
                <Link2 className="h-4 w-4" /> Link project
              </Button>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void startNew()}>
                <Plus className="h-4 w-4" /> New project
              </Button>
            </>
          )
        )
      }
    >
      {(choosing && !linked) || error ? (
        <>
          {choosing && !linked && (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (pick) void link(pick).then(() => setChoosing(false));
              }}
            >
              <select
                aria-label="Project to link"
                autoFocus
                required
                value={pick}
                disabled={disabled || !sessions?.length}
                onChange={(e) => setPick(e.target.value)}
                className="min-w-0 flex-1 basis-48 rounded-md border border-zinc-500/30 bg-transparent px-2 py-1 text-sm"
              >
                <option value="">{sessions ? (sessions.length ? "Choose a project" : "No projects") : "Loading projects"}</option>
                {(sessions ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
              <Button type="submit" size="sm" variant="outline" disabled={disabled}>
                Link
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setChoosing(false)}>
                Cancel
              </Button>
            </form>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
        </>
      ) : null}
    </Card>
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
  // the cards come with it: the versions would otherwise read "Not in the Media Library" until they arrive
  const [cards, siblings] = await Promise.all([
    cardsOfVersions(found.library.id, pieceVersions([found.piece])),
    listCollections(found.library.id).then((cs) => {
      const finals = cs.find(isFinals);
      return finals ? listPieces(found.library.id, finals.id) : [];
    }),
  ]);
  return { found, cards, others: siblings.filter((p) => p.id !== pieceId), workshop: await workshop };
}

/**
 * /finals/:pieceId: the piece in a window over the Finals list (App.tsx draws both on one route, so the list keeps its
 * search, filter and scroll), in whichever library the account can read (the first that answers, with its Finals or not).
 * A piece's cards are its own versions' (thumbnails, kind). Reads again when the library changes (a merge or a trash
 * elsewhere, a version added from Review). On /finals itself it draws nothing.
 */
export default function FinalsPiecePage() {
  const { pieceId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const me = useMe();
  // the saved copy paints at once; the change stream's library topic reads it again (lib/local-cache)
  const view = useCachedLoad<PieceView>(pieceId ? `/api/library/finals-piece/${pieceId}` : null, () => loadPieceView(pieceId));
  if (!pieceId) return null;
  const found = view.data ? view.data.found : undefined;
  const cards = view.data?.cards ?? [];
  const others = view.data?.others ?? [];
  const workshop = view.data?.workshop ?? {};
  const error = view.data ? null : view.error || null;
  const reload = () => void view.refresh().catch(() => {});
  const setFound = (next: { library: LibrarySummary; piece: Piece }) => view.set((v) => v && { ...v, found: next });
  // opened from the list: back in history (no second /finals entry); opened by a link: to the list
  const fromList = !!(location.state as { fromList?: boolean } | null)?.fromList;
  const close = () => (fromList ? navigate(-1) : navigate("/finals", { replace: true }));

  const library = found?.library ?? null;
  const piece = found?.piece;

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        aria-describedby={undefined}
        // opening a piece is to look at it: the name field takes focus only when clicked
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="flex max-h-[92dvh] w-full flex-col gap-0 overflow-hidden p-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:max-w-none max-sm:rounded-none max-sm:border-0 sm:max-w-5xl"
      >
        <DialogTitle className="sr-only">{piece?.label ?? "Piece"}</DialogTitle>
        {error && <p className="p-5 text-sm text-red-500">{error}</p>}
        {found === undefined && !error && <div aria-hidden="true" className="h-[520px]" />}
        {found === null && <p className="py-16 text-center text-sm text-zinc-500">Piece not found</p>}
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
            onGone={close}
            onReload={reload}
            onOpen={(id) => navigate(`/finals/${id}`, { replace: true, state: location.state })}
            onOpenSession={(path) => navigate(path)}
            linked={workshop[pieceId]}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
