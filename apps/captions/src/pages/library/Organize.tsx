import { type Collection, type LibrarySummary } from "@contracts/library";
import { listCollections } from "@/lib/library";

/**
 * How the Media Library is sorted into folders (api/library/organize.ts): chosen in setup step 4 and Library settings
 * only (CEO 11-19: one setting, one place; no upload or folder asks it). The folders are the library's own: files on
 * disk never move.
 */

/** The default folders' names, in their order: the folders "Standard" makes (the list DEFAULT_FOLDERS held before its removal). U3 drops this option. */
export const FOLDER_NAMES = "A-roll, B-roll, Sound effects, Graphics, Examples";

/**
 * The Media Library page's organizing, for its owner. `organized`: the library saved, its folders read fresh (a refresh
 * could join a read from before the default folders were made, and the page hears no notice of its own writes).
 */
export function useOrganize({ onSaved, setFolders }: { onSaved: (l: LibrarySummary) => void; setFolders: (c: Collection[]) => void }): { organized: (l: LibrarySummary) => Promise<void> } {
  const organized = async (l: LibrarySummary) => {
    onSaved(l);
    setFolders(await listCollections(l.id));
  };
  return { organized };
}
