import { promptDialog } from "@/lib/dialogs";
import type { ListSection } from "./List";

/** The list view's rows on screen, in order: a folded section's are not. What a Shift-click picks a run from. */
export const shownItems = <T,>(sections: ListSection<T>[]): T[] => sections.flatMap((s) => (!s.fold || s.fold.open ? s.items : []));

/** A modifier click (Shift, ⌘, Ctrl): a pick, not a visit. */
export const isPickClick = (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => e.shiftKey || e.metaKey || e.ctrlKey;

/** The one way a folder is named, everywhere: New folder asks for a name; null when it was left empty. */
export async function askFolderName(title = "New folder"): Promise<string | null> {
  return (await promptDialog({ title, ok: "Make folder" }))?.trim() || null;
}

/** Rename…: the new name, or null when it was left empty or not changed. */
export async function askRename(title: string, current: string): Promise<string | null> {
  const name = (await promptDialog({ title, value: current, ok: "Rename" }))?.trim();
  return name && name !== current ? name : null;
}

/** A folder as the browse views need it; a tool with folders inside folders sets `parentId`. */
export interface FolderNode {
  id: string;
  name: string;
  parentId?: string | null;
}

/** The folders from the top down to `id` (the top bar's trail); [] at the top or for a folder that is gone. */
export function folderPath<F extends FolderNode>(folders: F[], id: string | null | undefined): F[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: F[] = [];
  for (let f = id ? byId.get(id) : undefined; f && !out.includes(f); f = f.parentId ? byId.get(f.parentId) : undefined) out.unshift(f);
  return out;
}

/**
 * The folders for a Move to list, each under its parent (`depth` for the indent), in the order given. `except` and
 * everything inside it are left out: a folder can't move inside itself.
 */
export function folderOptions<F extends FolderNode>(folders: F[], except?: string): (F & { depth: number })[] {
  const ids = new Set(folders.map((f) => f.id));
  const byParent = new Map<string | null, F[]>();
  // a folder whose parent is gone is listed at the top
  for (const f of folders) {
    const p = f.parentId && ids.has(f.parentId) ? f.parentId : null;
    byParent.set(p, [...(byParent.get(p) ?? []), f]);
  }
  const out: (F & { depth: number })[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of byParent.get(parent) ?? []) {
      if (f.id === except) continue;
      out.push({ ...f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
