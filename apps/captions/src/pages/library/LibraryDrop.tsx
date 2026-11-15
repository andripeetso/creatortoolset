import { useState, type DragEvent, type ReactNode } from "react";
import type { WatchStatus } from "@contracts/library";
import { BIG_DROP, BigUploadDialog, dropOf, type FolderSize } from "@/components/LibraryProcessing";
import { droppedFiles } from "@/components/assistant/draft";
import { getWatch } from "@/lib/library";
import { droppedOnMac } from "@/lib/thisMac";

/**
 * Files and folders dropped anywhere on the Media Library page. A folder in the Mac app, with the server on this
 * computer (`readsFolders`), comes as its path and is read where it is, as Choose a folder does (a big one asks first,
 * with the offer to organize it); anywhere else a folder's videos, pictures and sounds upload like files dropped one by
 * one (`addFiles`, which asks first for a big drop). Returns the page root's handlers, the drop outline and the dialog.
 */

/** The files the library takes from a folder (the server's own kinds, api/library/routes.ts kindOf; watch.ts filesIn skips the rest too). */
export const MEDIA = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|aac|ogg|opus|flac|jpe?g|png|heic|webp|gif|tiff?)$/i;

export function useLibraryDrop({
  libraryId,
  readsFolders,
  offer,
  answerOffer,
  addFiles,
  onWatch,
  onError,
}: {
  libraryId: string | undefined;
  readsFolders: boolean;
  offer: boolean;
  answerOffer: (ai: boolean) => Promise<void>;
  addFiles: (files: File[]) => unknown;
  onWatch: (w: WatchStatus) => void;
  onError: (e: string) => void;
}): { props: { onDragOver: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDrop: (e: DragEvent) => void }; overlay: ReactNode; dialog: ReactNode } {
  const [dropping, setDropping] = useState(false);
  const [asking, setAsking] = useState<{ folder: string; size: FolderSize } | null>(null);

  // ponytail: the same two calls as FootageFolderCard's add and check; one helper if a third caller comes
  const addFolder = async (folder: string) => {
    if (!libraryId) return;
    const r = await fetch("/api/library/watch/folder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: folder, libraryId }) });
    if (!r.ok) return onError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Couldn't add that folder (${r.status})`);
    onWatch(await getWatch(libraryId));
  };
  const folderIn = async (folder: string) => {
    const r = await fetch(`/api/library/${libraryId}/watch/size?path=${encodeURIComponent(folder)}`).catch(() => null);
    const size = r?.ok ? ((await r.json()) as FolderSize) : null;
    if (size && size.files >= BIG_DROP) setAsking({ folder, size });
    else await addFolder(folder);
  };

  const props = {
    onDragOver: (e: DragEvent) => {
      if (!libraryId || !e.dataTransfer.types.includes("Files")) return;
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
      droppedFiles(e.dataTransfer, readsFolders ? droppedOnMac : undefined).then(
        (d) => {
          for (const f of d.folders) void folderIn(f);
          // a folder opened here: only what the library takes (a loose file dropped by itself goes in as it is)
          const files = d.folder ? d.files.filter((f) => !f.webkitRelativePath.includes("/") || MEDIA.test(f.name)) : d.files;
          if (files.length) void addFiles(files);
        },
        (x: unknown) => onError(x instanceof Error ? x.message : String(x)),
      );
    },
  };

  const overlay = dropping && (
    <div className="pointer-events-none fixed inset-2 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-violet-500/70 bg-violet-500/10 text-sm font-medium text-violet-400">
      Drop videos, pictures, sounds or a folder
    </div>
  );

  const dialog = asking && libraryId && (
    <BigUploadDialog
      libraryId={libraryId}
      drop={dropOf(asking.size)}
      title={`Add ${asking.size.files.toLocaleString()} clips from this folder?`}
      go="Add folder"
      offer={offer}
      onClose={() => setAsking(null)}
      onUpload={async (ai) => {
        setAsking(null);
        await answerOffer(ai); // before the folder: its files are filed as they come in
        await addFolder(asking.folder);
      }}
    />
  );

  return { props, overlay, dialog };
}
