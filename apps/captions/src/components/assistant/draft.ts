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

/**
 * A drop's files, with each dropped folder opened (and its folders) into the files inside it. A browser never sees
 * a folder's path, so its files upload like files dropped one by one. The entries are taken before the first await:
 * the drop's list is gone after the event.
 */
export async function droppedFiles(dt: DataTransfer): Promise<{ files: File[]; folder: boolean }> {
  const entries = Array.from(dt.items, (it) => it.webkitGetAsEntry?.() ?? null);
  if (!entries.some((e) => e?.isDirectory)) return { files: Array.from(dt.files), folder: false };
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
  const all = (await Promise.all(entries.filter((e): e is FileSystemEntry => !!e).map(walk))).flat();
  return { files: all.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), folder: true };
}

/** A video or recording in the box: it uploads as soon as it's added (id once it's in, api/assistant-files.ts). */
export type DraftFile = { key: string; name: string; size: number; pct: number; id?: string; error?: string };
/** What's in the box: the words, pictures, long pastes (sent as files beside the words) and videos. */
export type Draft = { text: string; images: AssistantImage[]; pasted: AssistantPaste[]; files: DraftFile[] };
export const EMPTY_DRAFT: Draft = { text: "", images: [], pasted: [], files: [] };
export const draftEmpty = (d: Draft) => !d.text.trim() && !d.images.length && !d.pasted.length && !d.files.length;
/** Still uploading, or one failed: the message can't go yet. */
export const filesPending = (d: Draft) => d.files.some((f) => !f.id);

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
