import type { FileRef, ImageRef } from "./types";
import { slug } from "./folder";

/** Extensions of what a turn sends the AI: pictures and PDFs. */
export const ATTACH_EXT: Record<ImageRef["type"] | FileRef["type"], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/** The folder's copy of a message's picture or file: attached/<n>-<name>.<ext>, n counted from 01 in the order they go (pictures, then files). */
export function attachedFile(f: { name: string; type: ImageRef["type"] | FileRef["type"] }, i: number): string {
  return `attached/${String(i + 1).padStart(2, "0")}-${slug(f.name.replace(/\.[a-z0-9]+$/i, ""))}.${ATTACH_EXT[f.type]}`;
}
