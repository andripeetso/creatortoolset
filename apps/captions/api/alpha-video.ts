import { spawn } from "node:child_process";
import { ffmpegCommand } from "./ffmpeg-runtime";

/** Alpha samples below this are visibly non-opaque after 8-bit conversion. */
const OPAQUE_THRESHOLD = 250;

export function hasTransparentPixels(alpha: Uint8Array): boolean {
  return alpha.length > 0 && alpha.some((value) => value < OPAQUE_THRESHOLD);
}

/**
 * Decode a small alpha-plane sample from the finished MOV. ProRes 4444 can
 * carry an alpha-capable pixel format while every encoded alpha value is still
 * opaque, so probing stream metadata alone is not enough.
 */
export async function assertMovHasTransparency(file: string): Promise<void> {
  const ffmpeg = ffmpegCommand();
  const child = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      file,
      "-vf",
      "alphaextract,scale=16:16:flags=neighbor,format=gray",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const chunks: Buffer[] = [];
  let error = "";
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => {
    error += chunk.toString();
    if (error.length > 4000) error = error.slice(-4000);
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.on("close", (value) => resolve(value ?? -1));
    child.on("error", reject);
  });
  const alpha = Buffer.concat(chunks);
  if (code !== 0 || !hasTransparentPixels(alpha)) {
    const detail = error.trim() ? ` (${error.trim()})` : "";
    throw new Error(
      `ProRes 4444 output has no usable transparency${detail}`
    );
  }
}
