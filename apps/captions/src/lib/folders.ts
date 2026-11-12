import { useLocation, useSearchParams } from "react-router";
import type { FolderTool, ToolFolder, ToolFolders } from "@contracts/folders";
import { askFolderName, askRename, folderOptions, folderPath } from "@/components/browse/browse";
import { byName, matches } from "@/components/browse/views";
import { confirmDialog } from "@/lib/dialogs";
import { useCachedLoad } from "@/lib/local-cache";
import { json } from "@/lib/uploads";

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
    move: async (ids: string[], folderId: string | null) => {
      set((d) => {
        const next = { ...d.items };
        for (const id of ids) {
          if (folderId) next[id] = folderId;
          else delete next[id];
        }
        return { ...d, items: next };
      });
      await moveItems(tool, ids, folderId).finally(again);
    },
  };
}
export type ToolFoldersState = ReturnType<typeof useToolFolders>;
