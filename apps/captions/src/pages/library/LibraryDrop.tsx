import { useState, type DragEvent, type ReactNode } from "react";
import type { WatchStatus } from "@contracts/library";
import { useBigFolder } from "@/components/LibraryProcessing";
import { droppedFiles } from "@/components/assistant/draft";
import { getWatch } from "@/lib/library";
import { droppedOnMac, thisMacBridge } from "@/lib/thisMac";
import { pathsInDrop } from "@/lib/onMac";

/**
 * Files and folders dropped anywhere on the Media Library page. A folder in the Mac app, with the server on this
 * computer (`readsFolders`), comes as its path and opens the same one dialog as Choose a folder (copy or keep, and for a
 * big one what it takes and the offer to organize it). Anywhere else a folder's videos, pictures and sounds go like files dropped one by
 * one (`addFiles`, which asks first for a big drop): in the Mac app with the server elsewhere each is indexed where it is on
 * this Mac, its path from the drop (pathsInDrop), and uploads only with the library's upload switch on; in a browser they upload. Returns
 * the page root's handlers, whether files are held over it and the dialog. A drag of the type `ignore` (the page's own
 * clips) is not a drop of files.
 */

/** The files the library takes from a folder (the server's own kinds, api/library/routes.ts kindOf; watch.ts filesIn skips the rest too). */
export const MEDIA = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|aac|ogg|opus|flac|jpe?g|png|heic|webp|gif|tiff?)$/i;

export function useLibraryDrop({
  libraryId,
  ignore,
  readsFolders,
  offer,
  answerOffer,
  addFiles,
  onWatch,
  onError,
}: {
  libraryId: string | undefined;
  ignore?: string;
  readsFolders: boolean;
  offer: boolean;
  answerOffer: (ai: boolean) => Promise<void>;
  addFiles: (files: File[], paths?: Map<File, string>) => unknown;
  onWatch: (w: WatchStatus) => void;
  onError: (e: string) => void;
}): { props: { onDragOver: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDrop: (e: DragEvent) => void }; dropping: boolean; dialog: ReactNode } {
  const [dropping, setDropping] = useState(false);
  const big = useBigFolder();

  // ponytail: the same call as FootageFolderCard's add; one helper if a third caller comes
  const addFolder = async (folder: string, copyTo?: string) => {
    if (!libraryId) return;
    const r = await fetch("/api/library/watch/folder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: folder, libraryId, copyTo }) });
    if (!r.ok) return onError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Couldn't add that folder (${r.status})`);
    onWatch(await getWatch(libraryId));
  };
  const folderIn = (folder: string) => big.check(folder, (copyTo) => addFolder(folder, copyTo), { libraryId, offerCopy: true, organize: { offer, answer: answerOffer } });

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
      // the Mac app with the server elsewhere: a folder is read here, and each file gets its place on this Mac from the
      // drop's own paths, so it is indexed where it is (lib/onMac.ts) instead of uploaded
      const onMac = !readsFolders && !!thisMacBridge();
      const items = onMac ? droppedOnMac() : undefined;
      // takes the drop's items now: they are gone after the event
      droppedFiles(e.dataTransfer, readsFolders ? droppedOnMac : undefined).then(
        async (d) => {
          await Promise.all(d.folders.map((f) => folderIn(f)));
          // a folder opened here: only what the library takes (a loose file dropped by itself goes in as it is)
          const files = d.folder ? d.files.filter((f) => !f.webkitRelativePath.includes("/") || MEDIA.test(f.name)) : d.files;
          const paths = onMac ? pathsInDrop(files, (await items) ?? [], d.paths) : d.paths;
          // loose files dropped beside folders come once the folders' dialogs are answered: one dialog at a time
          if (files.length) big.after(() => void addFiles(files, paths.size ? paths : undefined));
        },
        (x: unknown) => onError(x instanceof Error ? x.message : String(x)),
      );
    },
  };

  return { props, dropping, dialog: big.dialog };
}
