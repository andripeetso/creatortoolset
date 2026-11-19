import { checkUpload } from "@/lib/library";

/** A Media Library file on its way in (LibraryPage.tsx; its card while it goes: ./Placeholders.tsx), copies into the library's folder among them. */

export interface Upload {
  key: number;
  file: File;
  sent: number;
  /** the manual folder open when the file was dropped: it goes in there */
  folderId?: string;
  status: "waiting" | "checking" | "copying" | "uploading" | "added" | "duplicate" | "failed" | "cancelled";
  error?: string;
  inPlace?: boolean; // added where it is on this Mac, not uploaded
  path?: string; // where it is on this Mac, known from a Finder drop (once copied: the copy's)
  copyTo?: string; // copied here first (the library's folder on this Mac), then taken in from there
  final?: boolean; // refused for good (too large for this server): no Retry
  assetId?: string; // the clip it became: its card takes the placeholder's place once it is on the page
  aspect?: number; // its width / height once read (lib/onMac.ts shapeOf): its card's shape
}

/** A file's SHA-256 off the page's thread (hash.worker.ts), one worker per file: at most the server-call gate's few at once (./import-pool.ts). */
function hashFile(file: File): Promise<string> {
  const worker = new Worker(new URL("./hash.worker.ts", import.meta.url), { type: "module" });
  return new Promise<string>((ok, no) => {
    worker.onmessage = (e: MessageEvent<{ hex?: string; error?: string }>) => (e.data.hex ? ok(e.data.hex) : no(new Error(e.data.error)));
    worker.onerror = (e) => no(new Error(e.message));
    worker.postMessage(file);
  }).finally(() => worker.terminate());
}

/**
 * The clip this file already is in the library, asked before any of it is sent; null when it is new. The server is
 * asked by size first: only a file of a size it has is hashed (`onHashing` says so; a big one takes a while), and then
 * matched by the same hash an upload's finish checks. Any failure here is the caller's to ignore: the upload checks again.
 */
/**
 * The clip this file already is in the library, asked before any of it is sent; null when it is new. The server is
 * asked by size first: only a file of a size it has is hashed (`onHashing` says so; a big one takes a while), and then
 * matched by the same hash an upload's finish checks. Any failure here is the caller's to ignore: the upload checks again.
 */
export async function alreadyThere(libraryId: string, file: File, onHashing: () => void): Promise<string | null> {
  if (!(await checkUpload(libraryId, file.size)).maybe) return null;
  onHashing();
  return (await checkUpload(libraryId, file.size, await hashFile(file))).duplicateOf ?? null;
}
