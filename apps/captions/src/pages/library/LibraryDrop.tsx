import { useState, type DragEvent, type ReactNode } from "react";
import { PICTURE_FILE, type LibrarySummary } from "@contracts/library";
import { droppedFiles } from "@/components/assistant/draft";
import { droppedOnMac, thisMacBridge } from "@/lib/thisMac";
import { pathsInDrop } from "@/lib/onMac";
import { holdsMediaFolder } from "./Import";

/**
 * Files and folders dropped anywhere on the Media Library page: a dropped folder's media files and loose files go to
 * addFiles, where the import rule decides (./Import.tsx): inside a folder this Mac reads they are indexed where they are,
 * from outside one question says whether they are used where they are or copied into Imports/. A browser's files upload. Returns the page root's handlers,
 * whether files are held over it and the dialog. A drag of the type `ignore` (the page's own clips) is not a drop of files.
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
  onError,
}: {
  library: LibrarySummary | null;
  ignore?: string;
  readsFolders: boolean;
  addFiles: (files: File[], paths?: Map<File, string>) => unknown;
  onError: (e: string) => void;
}): { props: { onDragOver: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDrop: (e: DragEvent) => void }; dropping: boolean; dialog: ReactNode } {
  const [dropping, setDropping] = useState(false);
  const libraryId = library?.id;

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
          const dropped = (await items) ?? [];
          // a folder holding any workspace's Media folder (~/Movies with each workspace's inside): nothing of it goes in
          const holds = await holdsMediaFolder([...new Set([...d.folders, ...dropped.filter((i) => i.folder).map((i) => i.path)])]);
          if (holds) return onError(holds);
          // a folder's files: only what the library takes (a loose file dropped by itself goes in as it is)
          const files = d.files.filter((f) => !inFolder(f) || MEDIA.test(f.name));
          const paths = onMac ? pathsInDrop(files, dropped, d.paths) : d.paths;
          if (files.length) void addFiles(files, paths.size ? paths : undefined);
        },
        (x: unknown) => onError(x instanceof Error ? x.message : String(x)),
      );
    },
  };

  return { props, dropping, dialog: null };
}
