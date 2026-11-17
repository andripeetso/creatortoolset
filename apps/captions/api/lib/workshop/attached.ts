import type { ChatMessage, FileRef, ImageRef } from "./types";
import { attachedDir, slug } from "./folder";

/** Extensions of what a turn sends the AI: pictures and PDFs. */
export const ATTACH_EXT: Record<ImageRef["type"] | FileRef["type"], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/**
 * The folder's copy of a message's picture or file: attached/<message>/<n>-<name>.<ext>, n counted from 01 in the order
 * they go (its pictures, then its files, then its Media Library thumbnails). Every later turn finds it at the same path,
 * so a picture never reaches the AI on one turn only.
 */
export function attachedFile(f: { name: string; type: ImageRef["type"] | FileRef["type"] }, i: number, messageId: string): string {
  return `${attachedDir(messageId)}${String(i + 1).padStart(2, "0")}-${slug(f.name.replace(/\.[a-z0-9]+$/i, ""))}.${ATTACH_EXT[f.type]}`;
}

/** A message's stored pictures and PDFs with their folder paths: pictures first, then files. */
export function messageAttachments(m: Pick<ChatMessage, "id" | "images" | "files">) {
  const images = m.images ?? [];
  return [
    ...images.map((ref, i) => ({ kind: "image" as const, ref, file: attachedFile(ref, i, m.id) })),
    ...(m.files ?? []).map((ref, j) => ({ kind: "file" as const, ref, file: attachedFile(ref, images.length + j, m.id) })),
  ];
}
