import { useNavigate } from "react-router";
import { Trash2 } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu";
import { PointMenu } from "@/components/ui/point-menu";
import { useWorkspace } from "@/lib/workspace";
import { createDocument, deleteSession, docKindLabel, duplicateSession, listDocuments, patchSession, regenerateSessionTitle, sendTurn, sessionPath, statusSteps, useDocKinds, WORKSHOP_HOME, type PieceKind, type SessionPatch, type SessionStatus } from "@/lib/workshop";
import { markUnread, patchSummary, refreshSummaries, useSessionSummaries, type SessionSummary } from "@/lib/workshop-summary";
import { undoable } from "@/lib/undo";
import { alertDialog, confirmDialog } from "@/lib/dialogs";

/** How a converted copy is named: its title and the new format, the way Obsidian notes are named (TinyStory-Reel). */
const CONVERT_SUFFIX: Record<PieceKind, string> = { reel: "Reel", carousel: "Carousel", ad: "Ad", free: "Free", youtube: "YouTube", newsletter: "Newsletter", thread: "Thread", article: "Article" };

/**
 * The right-click menu on a session: Pin, Rename,
 * Regenerate title, Mark unread, Copy, Duplicate, Shelve, Delete. Closes on a click outside or Esc.
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
  readOnly,
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
  /** Copy only: the menu's changes are hidden */
  readOnly?: boolean;
}) {
  const kinds = useDocKinds();
  const navigate = useNavigate();
  const summary = useSessionSummaries()?.find((r: SessionSummary) => r.id === id);
  const hasReply = !!summary?.replyAt;
  const workspaces = useWorkspace((s) => s.projects);
  const here = summary?.projectId ?? useWorkspace.getState().currentProjectId;

  const fail = (e: unknown) => void alertDialog({ title: e instanceof Error ? e.message : String(e) });
  /** Shows at once, saved on the server; a failed save brings the sidebar back to the server's word. */
  const put = (patch: Partial<SessionSummary> & SessionPatch) => {
    patchSummary(id, patch);
    return patchSession(id, patch).then(
      () => onChanged?.(),
      (e) => {
        void refreshSummaries();
        onChanged?.();
        throw e;
      },
    );
  };
  /** `back` is what the session had before, as the patches that put it there: ⌘Z sends them (lib/undo.ts). */
  const change = (what: string, patch: Partial<SessionSummary> & SessionPatch, back: (Partial<SessionSummary> & SessionPatch)[]) => {
    onClose();
    put(patch).then(
      () =>
        undoable(what, async () => {
          for (const was of back) await put(was);
        }),
      fail,
    );
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
      if (!piece) throw new Error("No written piece to copy");
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
      if (!from) throw new Error("No written piece to convert");
      const copy = await duplicateSession(id);
      await patchSession(copy.id, { title: `${title.trim() || "Untitled project"}-${CONVERT_SUFFIX[kind]}`, status: "writing" });
      const doc = await createDocument(copy.id, { kind });
      await sendTurn(copy.id, { docId: doc.id, text: `Write this ${docKindLabel(kind)} from the ${docKindLabel(from.kind)} in this project.` });
      void refreshSummaries();
      onChanged?.();
      navigate(`${sessionPath(copy.id)}?doc=${doc.id}`);
    })().catch(fail);
  };
  // the only way a session changes workspace: switching workspace never takes the open one along
  const move = (to: { id: string; name: string }) => {
    onClose();
    const back = here;
    put({ moveTo: to.id, projectId: to.id })
      .then(() => {
        void refreshSummaries(); // it leaves this workspace's list
        if (open) navigate(WORKSHOP_HOME);
        if (back) undoable(`moved to ${to.name}`, () => put({ moveTo: back, projectId: back }).then(() => void refreshSummaries()));
      })
      .catch(fail);
  };
  const remove = () => {
    onClose();
    void (async () => {
      if (!(await confirmDialog({ title: `Delete “${title || "Untitled project"}”?`, body: "This cannot be undone.", ok: "Delete", danger: true }))) return;
      await deleteSession(id);
      if (open) navigate(WORKSHOP_HOME);
      void refreshSummaries();
      onChanged?.();
    })().catch(fail);
  };

  const shelved = status === "shelved";
  const others = workspaces.filter((w) => w.id !== here);

  return (
    <PointMenu at={{ x, y }} onClose={onClose} label="Project" className="w-56">
      {!readOnly && (
        <>
          <DropdownMenuItem onSelect={() => change(pinned ? "unpinned" : "pinned", { pinned: !pinned }, [{ pinned: !!pinned }])}>

            {pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => (onClose(), onRename())}>
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={regenerate}>
            Regenerate title
          </DropdownMenuItem>
          {hasReply ? (
            <DropdownMenuItem onSelect={() => (onClose(), markUnread(id))}>
              Mark unread
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          Copy
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-48">
          <DropdownMenuItem onSelect={() => copy(`${window.location.origin}${sessionPath(id)}`)}>
            Copy link
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => copy(title || "Untitled project")}>Copy name</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => copy(mainPieceText())}>Copy script</DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {!readOnly && (
        <>
          <DropdownMenuItem onSelect={duplicate}>
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              Convert to
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              {kinds.map((k) => (
                <DropdownMenuItem key={k.id} onSelect={() => convert(k.id)}>
                  {k.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {others.length > 0 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                Move to
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                {others.map((w) => (
                  <DropdownMenuItem key={w.id} onSelect={() => move(w)}>
                    {w.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          <DropdownMenuItem onSelect={() => change(shelved ? "unshelved" : "shelved", { status: shelved ? "writing" : "shelved" }, statusSteps(shelved ? "writing" : "shelved", status ?? "draft").map((s) => ({ status: s })))}>

            {shelved ? "Unshelve" : "Shelve"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={remove}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </>
      )}
    </PointMenu>
  );
}
