import type { AssistantImage, AssistantPaste } from "@contracts/assistant";
import { PASTE_AS_FILE, fileBase64, shrinkImage } from "@/lib/workshop";
// What goes with an assistant message (Composer.tsx, AssistantDock.tsx): pictures and long pastes.

/** At most this many pictures go with one message. */
export const MAX_PICTURES = 6;
/** Longest side of a picture sent, and the size above which a screenshot goes as JPEG instead of PNG. */
const MAX_SIDE = 2000;
const MAX_PNG_BYTES = 4 * 1024 * 1024;

/** What's in the box: the words, pictures and long pastes (sent as files beside the words). */
export type Draft = { text: string; images: AssistantImage[]; pasted: AssistantPaste[] };
export const EMPTY_DRAFT: Draft = { text: "", images: [], pasted: [] };
export const draftEmpty = (d: Draft) => !d.text.trim() && !d.images.length && !d.pasted.length;

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
