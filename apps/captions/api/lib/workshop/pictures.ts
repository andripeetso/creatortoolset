import { LIMITS } from "./validate";
import type { ImageRef } from "./types";

/** Pictures a session keeps (chat messages and pieces alike), by type. */
export const PICTURE_EXT: Record<ImageRef["type"], string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
export const PICTURE_TYPES = Object.keys(PICTURE_EXT) as ImageRef["type"][];

/** The first bytes each type starts with: a text file sent as a picture is refused. */
const SIGNATURE: Record<ImageRef["type"], (b: Buffer) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

/** A picture sent for a piece: base64 data, checked to be a real picture of the type it says. */
export function parsePictureUpload(body: unknown): { name: string; type: ImageRef["type"]; bytes: Buffer } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const type = b.type;
  if (typeof type !== "string" || !PICTURE_TYPES.includes(type as ImageRef["type"])) throw new Error("Pictures must be JPEG, PNG or WebP");
  if (typeof b.data !== "string" || !b.data) throw new Error("No picture sent");
  if (b.data.length > LIMITS.imageData) throw new Error("A picture is too big: send it under 5 MB");
  const bytes = Buffer.from(b.data, "base64");
  const kind = type as ImageRef["type"];
  if (!bytes.length || !SIGNATURE[kind](bytes)) throw new Error("That file is not a picture");
  return { name: typeof b.name === "string" ? b.name.slice(0, 200) : "", type: kind, bytes };
}
