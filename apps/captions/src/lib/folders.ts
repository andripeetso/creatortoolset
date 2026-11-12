import { useLocation, useSearchParams } from "react-router";
import { toast } from "sonner";
import { SHAREABLE_TOOLS, type FolderTool, type ToolFolder, type ToolFolders } from "@contracts/folders";
import { askFolderName, askRename, folderOptions, folderPath } from "@/components/browse/browse";
import { byName, matches } from "@/components/browse/views";
import { confirmDialog } from "@/lib/dialogs";
import { useCachedLoad } from "@/lib/local-cache";
import { json } from "@/lib/uploads";
import { undoable } from "@/lib/undo";

/**
 * Folders in a tool with none of its own (api/folders.ts): the person's folders and which item is in which. The open
 * folder is the page's `?f=`. A search looks everywhere: the folders whose names match and the items from every folder.
 */

const url = (t: FolderTool) => `/api/folders/${t}`;
const send = <T>(u: string, method: string, body?: unknown) =>
  fetch(u, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => json<T>(r));

export const getFolders = (t: FolderTool) => send<ToolFolders>(url(t), "GET");
export const makeFolder = (t: FolderTool, name: string, parentId: string | null) => send<ToolFolder>(url(t), "POST", { name, parentId });
export const patchFolder = (t: FolderTool, id: string, patch: { name?: string; parentId?: string | null }) => send<ToolFolder>(`${url(t)}/${id}`, "PATCH", patch);
export const deleteFolder = (t: FolderTool, id: string) => send<{ ok: true }>(`${url(t)}/${id}`, "DELETE");
export const shareFolder = (t: FolderTool, id: string) => send<ToolFolder>(`${url(t)}/${id}/share`, "POST");
export const unshareFolder = (t: FolderTool, id: string) => send<ToolFolder>(`${url(t)}/${id}/share`, "DELETE");
/** The page a shared folder's link opens (App.tsx); only Video Notes has one. */
export const sharedFolderUrl = (token: string) => `${window.location.origin}/clips/f/${token}`;
export const moveItems = (t: FolderTool, ids: string[], folderId: string | null) => send<{ items: ToolFolders["items"] }>(`${url(t)}/items`, "PUT", { ids, folderId });

const EMPTY: ToolFolders = { folders: [], items: {} };

/** `enabled` false: no folders asked for (a page used without an account). */
export function useToolFolders<T extends { id: string }>(tool: FolderTool, items: T[], q: string, enabled = true) {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const load = useCachedLoad<ToolFolders>(enabled ? url(tool) : null, () => getFolders(tool));
  const data = load.data ?? EMPTY;
  const byId = new Map(data.folders.map((f) => [f.id, f]));
  /** the folder an item is in; null at the top (or when its folder is gone) */
  const folderOf = (id: string) => {
    const f = data.items[id];
    return f && byId.has(f) ? f : null;
  };
  const asked = params.get("f");
  const open = asked && byId.has(asked) ? asked : null;
  const searching = !!q.trim();
  const inside = (fid: string) => items.filter((i) => folderOf(i.id) === fid);
  const set = (change: (d: ToolFolders) => ToolFolders) => load.set((d) => change(d ?? EMPTY));
  const again = () => void load.refresh().catch(() => {});

  return {
    open,
    trail: folderPath(data.folders, open),
    /** the folders on screen: in the open one, or every one whose name matches the search */
    folders: (searching ? data.folders.filter((f) => matches(q, f.name)) : data.folders.filter((f) => f.parentId === open)).sort(byName),
    /** the items on screen: in the open folder, or every match when searching */
    here: searching ? items : items.filter((i) => folderOf(i.id) === open),
    inside,
    /** "3 items", the folders inside counted too */
    countOf: (fid: string) => inside(fid).length + data.folders.filter((f) => f.parentId === fid).length,
    to: (fid: string | null) => (fid ? `${pathname}?f=${fid}` : pathname),
    /** "Move to": the top, then every folder under its parent; not the one it is in */
    options: (current: string | null) => [
      ...(current ? [{ id: null, name: "Top level", depth: 0 }] : []),
      ...folderOptions(data.folders).filter((f) => f.id !== current),
    ],
    folderOf,
    /** the dataTransfer type this tool's items carry when dragged onto a folder */
    dragType: `application/x-ct-${tool}-item`,
    /** what an item's card or row spreads, so it can be dragged onto a folder */
    drag: (id: string) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData(`application/x-ct-${tool}-item`, id);
        e.dataTransfer.effectAllowed = "move";
      },
    }),
    newFolder: async () => {
      const name = await askFolderName();
      if (name) await makeFolder(tool, name, open).then(again);
    },
    rename: async (f: ToolFolder) => {
      const name = await askRename("Rename folder", f.name);
      if (!name) return;
      set((d) => ({ ...d, folders: d.folders.map((x) => (x.id === f.id ? { ...x, name } : x)) }));
      await patchFolder(tool, f.id, { name }).finally(again);
    },
    remove: async (f: ToolFolder) => {
      const yes = await confirmDialog({ title: `Delete the folder “${f.name}”?`, body: "What is in it moves up one level.", ok: "Delete folder", danger: true });
      if (yes) await deleteFolder(tool, f.id).finally(again);
    },
    /** Whole folders can be shared by a link in this tool. */
    shareable: SHAREABLE_TOOLS.includes(tool),
    /** Turns the folder's link on (kept if it is on) and copies it. */
    share: async (f: ToolFolder) => {
      const token = f.share
        ? Promise.resolve(f.share)
        : shareFolder(tool, f.id).then((on) => {
            set((d) => ({ ...d, folders: d.folders.map((x) => (x.id === f.id ? on : x)) }));
            return on.share!;
          });
      try {
        // a browser may refuse a copy made after waiting on the server, so a new link is handed over as a promise
        if (f.share || typeof ClipboardItem === "undefined") await navigator.clipboard.writeText(sharedFolderUrl(await token));
        else await navigator.clipboard.write([new ClipboardItem({ "text/plain": token.then((t) => new Blob([sharedFolderUrl(t)], { type: "text/plain" })) })]);
        toast.success("Link copied", { description: "Anyone with it can watch the clips in this folder and the folders inside it." });
      } catch {
        toast(sharedFolderUrl(await token), { description: "Copy this link to share the folder." });
      }
    },
    unshare: async (f: ToolFolder) => {
      const yes = await confirmDialog({ title: `Stop sharing “${f.name}”?`, body: "Its link stops working. Sharing again makes a new link.", ok: "Stop sharing", danger: true });
      if (!yes) return;
      set((d) => ({ ...d, folders: d.folders.map((x) => (x.id === f.id ? { ...x, share: undefined } : x)) }));
      await unshareFolder(tool, f.id).finally(again);
    },
    /** `undo` false: no ⌘Z (a clip just made inside a folder). */
    move: async (ids: string[], folderId: string | null, undo = true) => {
      // where each was, for ⌘Z
      const was = new Map<string | null, string[]>();
      for (const id of ids) was.set(folderOf(id), [...(was.get(folderOf(id)) ?? []), id]);
      const put = (moves: [string | null, string[]][]) => {
        set((d) => {
          const next = { ...d.items };
          for (const [to, some] of moves)
            for (const id of some) {
              if (to) next[id] = to;
              else delete next[id];
            }
          return { ...d, items: next };
        });
        return Promise.all(moves.map(([to, some]) => moveItems(tool, some, to))).finally(again);
      };
      await put([[folderId, ids]]);
      if (undo) undoable("moved", () => put([...was]), ids.length);
    },
  };
}
export type ToolFoldersState = ReturnType<typeof useToolFolders>;
