import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { Archive, ArchiveRestore, ChevronRight, CircleDot, Copy, CopyPlus, Link2, Pencil, Pin, PinOff, Repeat2, Sparkles, Trash2 } from "lucide-react";
import { createDocument, deleteSession, docKindLabel, duplicateSession, listDocuments, patchSession, regenerateSessionTitle, sendTurn, sessionPath, useDocKinds, WORKSHOP_HOME, type PieceKind, type SessionPatch, type SessionStatus } from "@/lib/workshop";
import { markUnread, patchSummary, refreshSummaries, useSessionSummaries, type SessionSummary } from "@/lib/workshop-summary";
import { alertDialog, confirmDialog } from "@/lib/dialogs";

/** A row that opens its own menu beside it on hover, like a Mac submenu; a click works too, for touch. */
function Sub({ icon, label, item, flip, children }: { icon: React.ReactNode; label: string; item: string; flip: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open} className={`${item} ${open ? "bg-zinc-800" : ""}`} onClick={() => setOpen((v) => !v)}>
        {icon} {label}
        <ChevronRight className="ml-auto h-3.5 w-3.5 text-zinc-500" />
      </button>
      {open ? (
        // the gap is padding, not margin, so the pointer never leaves the menu on its way over
        <div className={`absolute top-0 ${flip ? "right-full pr-1" : "left-full pl-1"}`}>
          <div role="menu" className="w-48 rounded-xl border border-zinc-700 bg-zinc-900 p-1 shadow-2xl">{children}</div>
        </div>
      ) : null}
    </div>
  );
}

/** How a converted copy is named: its title and the new format, the way Obsidian notes are named (TinyStory-Reel). */
const CONVERT_SUFFIX: Record<PieceKind, string> = { reel: "Reel", carousel: "Carousel", ad: "Ad", free: "Free", youtube: "YouTube", newsletter: "Newsletter", thread: "Thread", article: "Article" };

/**
 * The right-click menu on a session: Pin, Rename,
 * Regenerate title, Mark unread, Copy, Duplicate, Shelve, Delete. Closes on a click outside, Esc or scroll.
 */
export function SessionMenu({
  id,
  title,
  status,
  pinned,
  open,
  x,
  y,
  onClose,
  onRename,
  onChanged,
}: {
  id: string;
  title: string;
  status?: SessionStatus;
  pinned?: boolean;
  /** this is the session on screen */
  open?: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  /** after a change the list page reloads its own rows */
  onChanged?: () => void;
}) {
  const kinds = useDocKinds();
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const summary = useSessionSummaries()?.find((r: SessionSummary) => r.id === id);
  const hasReply = !!summary?.replyAt;

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const fail = (e: unknown) => void alertDialog({ title: e instanceof Error ? e.message : String(e) });
  // shows at once, saved on the server; a failed save brings the sidebar back to the server's word
  const change = (patch: Partial<SessionSummary>, server: SessionPatch) => {
    onClose();
    patchSummary(id, patch);
    patchSession(id, server)
      .then(() => onChanged?.())
      .catch((e) => {
        fail(e);
        void refreshSummaries();
        onChanged?.();
      });
  };
  const copy = (text: string | Promise<string>) => {
    onClose();
    void Promise.resolve(text)
      .then((t) => navigator.clipboard.writeText(t))
      .catch(fail);
  };
  const mainPieceText = () =>
    listDocuments(id).then((docs) => {
      const piece = docs.find((d) => d.kind !== "notes" && d.blocks.some((b) => b.text.trim()));
      if (!piece) throw new Error("There is no written piece to copy yet");
      return piece.blocks.map((b) => b.text).join("\n\n");
    });
  const regenerate = () => {
    onClose();
    regenerateSessionTitle(id)
      .then(({ title: next }) => {
        patchSummary(id, { title: next });
        window.dispatchEvent(new CustomEvent("workshop:renamed", { detail: { id, title: next } }));
        onChanged?.();
      })
      .catch(fail);
  };
  const duplicate = () => {
    onClose();
    duplicateSession(id)
      .then((s) => {
        void refreshSummaries();
        onChanged?.();
        navigate(sessionPath(s.id));
      })
      .catch(fail);
  };
  // Convert to: a copy of the session with a new piece in that format, written by the AI from the
  // session's written piece, which it reads beside the new one. Opens the copy on the new piece while it writes.
  const convert = (kind: PieceKind) => {
    onClose();
    void (async () => {
      const from = (await listDocuments(id)).find((d) => d.kind !== "notes" && d.blocks.some((b) => b.text.trim()));
      if (!from) throw new Error("There is no written piece to convert yet");
      const copy = await duplicateSession(id);
      await patchSession(copy.id, { title: `${title.trim() || "Untitled session"}-${CONVERT_SUFFIX[kind]}`, status: "writing" });
      const doc = await createDocument(copy.id, { kind });
      await sendTurn(copy.id, { docId: doc.id, text: `Write this ${docKindLabel(kind)} from the ${docKindLabel(from.kind)} in this session.` });
      void refreshSummaries();
      onChanged?.();
      navigate(`${sessionPath(copy.id)}?doc=${doc.id}`);
    })().catch(fail);
  };
  const remove = () => {
    onClose();
    void (async () => {
      if (!(await confirmDialog({ title: `Delete “${title || "Untitled session"}” for good?`, body: "This cannot be undone.", ok: "Delete", danger: true }))) return;
      await deleteSession(id);
      if (open) navigate(WORKSHOP_HOME);
      void refreshSummaries();
      onChanged?.();
    })().catch(fail);
  };

  const shelved = status === "shelved";
  const item = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-zinc-200 hover:bg-zinc-800";
  const left = Math.max(8, Math.min(x, window.innerWidth - 240));
  const flip = left + 224 + 200 > window.innerWidth; // no room on the right: submenus open to the left
  const top = Math.max(8, Math.min(y, window.innerHeight - 360));

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Session"
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[60] w-56 rounded-xl border border-zinc-700 bg-zinc-900 p-1 text-[13px] shadow-2xl"
      style={{ left, top }}
    >
      <button type="button" role="menuitem" className={item} onClick={() => change({ pinned: !pinned }, { pinned: !pinned })}>
        {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        {pinned ? "Unpin" : "Pin"}
      </button>
      <button type="button" role="menuitem" className={item} onClick={() => (onClose(), onRename())}>
        <Pencil className="h-3.5 w-3.5" /> Rename
      </button>
      <button type="button" role="menuitem" className={item} onClick={regenerate}>
        <Sparkles className="h-3.5 w-3.5" /> Regenerate title
      </button>
      {hasReply ? (
        <button type="button" role="menuitem" className={item} onClick={() => (onClose(), markUnread(id))}>
          <CircleDot className="h-3.5 w-3.5" /> Mark unread
        </button>
      ) : null}
      <div className="my-1 h-px bg-zinc-800" />
      <Sub icon={<Copy className="h-3.5 w-3.5" />} label="Copy" item={item} flip={flip}>
        <button type="button" role="menuitem" className={item} onClick={() => copy(`${window.location.origin}${sessionPath(id)}`)}>
          <Link2 className="h-3.5 w-3.5" /> Copy link
        </button>
        <button type="button" role="menuitem" className={item} onClick={() => copy(title || "Untitled session")}>
          Copy name
        </button>
        <button type="button" role="menuitem" className={item} onClick={() => copy(mainPieceText())}>
          Copy script
        </button>
      </Sub>
      <button type="button" role="menuitem" className={item} onClick={duplicate}>
        <CopyPlus className="h-3.5 w-3.5" /> Duplicate
      </button>
      <Sub icon={<Repeat2 className="h-3.5 w-3.5" />} label="Convert to" item={item} flip={flip}>
        {kinds.map((k) => (
          <button key={k.id} type="button" role="menuitem" className={item} onClick={() => convert(k.id)}>
            {k.label}
          </button>
        ))}
      </Sub>
      <button type="button" role="menuitem" className={item} onClick={() => change({ status: shelved ? "writing" : "shelved" }, { status: shelved ? "writing" : "shelved" })}>
        {shelved ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
        {shelved ? "Unshelve" : "Shelve"}
      </button>
      <div className="my-1 h-px bg-zinc-800" />
      <button type="button" role="menuitem" className={`${item} text-red-300 hover:bg-red-500/10`} onClick={remove}>
        <Trash2 className="h-3.5 w-3.5" /> Delete
      </button>
    </div>,
    document.body,
  );
}
