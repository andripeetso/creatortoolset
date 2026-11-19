import { useState, type DragEvent, type ReactNode } from "react";
import { PICTURE_FILE, type LibrarySummary, type WatchStatus } from "@contracts/library";
import { THIS_COMPUTER } from "@contracts/storage";
import { droppedFiles } from "@/components/assistant/draft";
import { getWatch } from "@/lib/library";
import { thisMacDevice } from "@/lib/providers";
import { droppedOnMac, thisMacBridge } from "@/lib/thisMac";
import { pathsInDrop } from "@/lib/onMac";

/**
 * Files and folders dropped anywhere on the Media Library page, with no question: the library's stored answer decides
 * (settings.importMode; unset reads as in place). In place, a dropped folder becomes a Source media row at once, with no
 * question however big (11-19: a drop means "add these"; the monthly budget holds the analysis), and is indexed where it is. Under Copy, a folder's files and loose files go to addFiles,
 * which copies them into the first Source media row on this computer (./Import.tsx). A browser's files upload. Returns
 * the page root's handlers, whether files are held over it and the dialog. A drag of the type `ignore` (the page's own
 * clips) is not a drop of files.
 */

/** The files the library takes from a folder (the server's own kinds, api/library/routes.ts kindOf; watch.ts filesIn skips the rest too). */
const AV = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|aac|ogg|opus|flac)$/i;
export const MEDIA = { test: (name: string) => AV.test(name) || PICTURE_FILE.test(name) };

/** A file of a dropped folder (a loose file's webkitRelativePath is empty or absent). */
const inFolder = (f: File) => (f.webkitRelativePath || "").includes("/");

export function useLibraryDrop({
  library,
  ignore,
  readsFolders,
  addFiles,
  onWatch,
  onError,
}: {
  library: LibrarySummary | null;
  ignore?: string;
  readsFolders: boolean;
  addFiles: (files: File[], paths?: Map<File, string>) => unknown;
  onWatch: (w: WatchStatus) => void;
  onError: (e: string) => void;
}): { props: { onDragOver: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDrop: (e: DragEvent) => void }; dropping: boolean; dialog: ReactNode } {
  const [dropping, setDropping] = useState(false);
  const libraryId = library?.id;

  // the folder becomes a Source media row on this computer, the request Settings → Folders makes (api/devices-storage.ts)
  const addFolder = async (folder: string) => {
    if (!libraryId) return;
    const r = await fetch("/api/devices/storage/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "footage", host: thisMacDevice() ?? THIS_COMPUTER, path: folder }),
    });
    const j = r.ok ? {} : ((await r.json().catch(() => ({}))) as { error?: string });
    // a folder already in the list is what the person wanted: not an error (FoldersStep's send)
    if (!r.ok && !/already/i.test(j.error ?? "")) return onError(j.error ?? "Could not add the folder");
    onWatch(await getWatch(libraryId));
  };
  const folderIn = (folder: string) => addFolder(folder).catch((x: unknown) => onError(x instanceof Error ? x.message : String(x)));

  const props = {
    onDragOver: (e: DragEvent) => {
      if (!libraryId || !e.dataTransfer.types.includes("Files") || (ignore && e.dataTransfer.types.includes(ignore))) return;
      e.preventDefault();
      e.stopPropagation(); // the page's drop, not the assistant's around it
      setDropping(true);
    },
    onDragLeave: (e: DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropping(false),
    onDrop: (e: DragEvent) => {
      setDropping(false);
      if (!libraryId || !e.dataTransfer.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      // the Mac app with the server elsewhere: each file gets its place on this Mac from the drop's own paths, so it is
      // indexed where it is (lib/onMac.ts) instead of uploaded
      const onMac = !readsFolders && !!thisMacBridge();
      const items = onMac ? droppedOnMac() : undefined;
      // takes the drop's items now: they are gone after the event
      droppedFiles(e.dataTransfer, readsFolders ? droppedOnMac : undefined).then(
        async (d) => {
          // under Copy a folder's files are copied in by addFiles, so no row is made for it
          const copying = library?.settings.importMode === "copy";
          if (!copying) await Promise.all(d.folders.map((f) => folderIn(f)));
          // a folder's files: only what the library takes (a loose file dropped by itself goes in as it is); in place a
          // folder's files are its row's to index
          const files = d.files
            .filter((f) => !inFolder(f) || MEDIA.test(f.name))
            .filter((f) => copying || !d.folders.length || !inFolder(f));
          const paths = onMac ? pathsInDrop(files, (await items) ?? [], d.paths) : d.paths;
          if (files.length) void addFiles(files, paths.size ? paths : undefined);
        },
        (x: unknown) => onError(x instanceof Error ? x.message : String(x)),
      );
    },
  };

  return { props, dropping, dialog: null };
}
