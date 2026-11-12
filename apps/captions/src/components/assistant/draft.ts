import type { AssistantImage, AssistantPaste } from "@contracts/assistant";
import { PASTE_AS_FILE, fileBase64, shrinkImage } from "@/lib/workshop";
// What goes with an assistant message (Composer.tsx, AssistantDock.tsx): pictures and long pastes.

/** At most this many pictures go with one message. */
export const MAX_PICTURES = 6;
/** Longest side of a picture sent, and the size above which a screenshot goes as JPEG instead of PNG. */
const MAX_SIDE = 2000;
const MAX_PNG_BYTES = 4 * 1024 * 1024;

/** At most this many videos go with one message (MAX_FILES in api/assistant.ts). */
export const MAX_FILES = 5;

/** At most this many folders go with one message (MAX_PATHS in api/assistant.ts). */
export const MAX_FOLDERS = 5;

/**
 * A drop's files, with each dropped folder opened (and its folders) into the files inside it. In the Mac app a folder
 * comes as its path instead (`dropped` gives the drop's Finder items, nothing uploads), and each loose file has its path
 * too (`paths`); a browser sees neither, so there a folder's files upload like files dropped one by one. The entries are
 * taken before the first await: the drop's list is gone after the event.
 */
export async function droppedFiles(
  dt: DataTransfer,
  dropped?: () => Promise<Array<{ path: string; folder: boolean }> | undefined>,
): Promise<{ files: File[]; folder: boolean; folders: string[]; paths: Map<File, string> }> {
  const entries = Array.from(dt.items, (it) => it.webkitGetAsEntry?.() ?? null);
  const top = Array.from(dt.files);
  const items = (await dropped?.()) ?? [];
  const folders = items.filter((x) => x.folder).map((x) => x.path);
  // a loose file's path, by its name: only when one dropped item has it (two of the same name upload as they are);
  // one form of accented letters on both sides
  const paths = new Map<File, string>();
  const nfc = (n: string) => n.normalize("NFC");
  const pathOf = (f: File) => {
    const same = items.filter((x) => !x.folder && nfc(x.path.split("/").pop() ?? "") === nfc(f.name));
    if (same.length === 1) paths.set(f, same[0]!.path);
  };
  if (!entries.some((e) => e?.isDirectory)) {
    top.forEach(pathOf);
    return { files: top, folder: false, folders: [], paths };
  }
  const walk = async (e: FileSystemEntry): Promise<File[]> => {
    if (e.isFile) return [await new Promise<File>((ok, no) => (e as FileSystemFileEntry).file(ok, no))];
    const reader = (e as FileSystemDirectoryEntry).createReader();
    const out: File[] = [];
    // readEntries hands them over in batches (about 100) until an empty one
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((ok, no) => reader.readEntries(ok, no));
      if (!batch.length) return out;
      for (const b of batch) if (!b.name.startsWith(".")) out.push(...(await walk(b)));
    }
  };
  // with the folders' paths, only the loose files beside them are read
  const read = entries.filter((e): e is FileSystemEntry => !!e && !(folders.length && e.isDirectory));
  const all = (await Promise.all(read.map(async (e) => {
    const got = await walk(e);
    if (e.isFile) got.forEach(pathOf);
    return got;
  }))).flat();
  return { files: all.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), folder: !folders.length, folders, paths };
}

/**
 * A video or recording in the box: it uploads as soon as it's added. `id` comes once the upload is made, and the message
 * may go from then on (the server waits for the rest, api/assistant.ts); `done` once it's all in. `path`: where it is on
 * this Mac (dropped in the Mac app): its reply starts without waiting, and a server on this Mac takes it without an upload.
 */
export type DraftFile = { key: string; name: string; size: number; pct: number; id?: string; done?: boolean; error?: string; path?: string };
/** What's in the box: the words, pictures, long pastes (sent as files beside the words) and videos. */
export type Draft = { text: string; images: AssistantImage[]; pasted: AssistantPaste[]; files: DraftFile[]; folders: string[] };
export const EMPTY_DRAFT: Draft = { text: "", images: [], pasted: [], files: [], folders: [] };
export const draftEmpty = (d: Draft) => !d.text.trim() && !d.images.length && !d.pasted.length && !d.files.length && !d.folders.length;
/** A folder's last name, for its chip. */
export const folderName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
/** An upload not made yet, or one failed: the message can't go yet (one still uploading can). */
export const filesPending = (d: Draft) => d.files.some((f) => !f.id || f.error);

/** A video or a recording's sound (by type, or by name when the type is missing). */
export const isMediaFile = (f: File) => /^(video|audio)\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|aac|ogg)$/i.test(f.name);

/** A screenshot dragged from the corner preview can arrive without a type: the name says it's a picture. */
export const isPicture = (f: File) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(f.name);

/** A paste this long or with this many lines becomes a file chip instead of filling the box. */
export const isLongPaste = (t: string) => t.length >= PASTE_AS_FILE || t.split("\n").length > 25;

export const lineCount = (t: string) => t.split("\n").length;

/** A picture ready to send: at most 2000 px on the long side; a screenshot stays PNG unless that's over 4 MB, a photo goes as JPEG. */
export async function toPicture(file: File): Promise<AssistantImage> {
  const name = file.name || "Screenshot.png";
  const jpeg = async () => {
    const pic = await shrinkImage(file, MAX_SIDE);
    URL.revokeObjectURL(pic.url);
    return { name: name.replace(/\.\w+$/, "") + ".jpg", type: "image/jpeg" as const, data: pic.data };
  };
  if (/jpe?g/i.test(file.type || file.name)) return jpeg();
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`Can't read ${name}: send a PNG, JPEG, WebP or GIF`);
  });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const png = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/png"));
  if (!png || png.size > MAX_PNG_BYTES) return jpeg();
  return { name: name.replace(/\.\w+$/, "") + ".png", type: "image/png", data: await fileBase64(new File([png], name)) };
}
