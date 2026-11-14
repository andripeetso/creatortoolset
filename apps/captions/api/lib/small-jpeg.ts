import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ffmpeg } from "../library/media/run";
import { env } from "./env";

/** A picture file of any size as a JPEG no longer than `side` on its long side, in base64 for an AI to look at; null when it cannot be read. */
export async function smallJpeg(file: string, side: number): Promise<string | null> {
  const tmp = path.join(env.dataDir, `.small-${randomBytes(6).toString("hex")}.jpg`);
  try {
    await mkdir(env.dataDir, { recursive: true });
    await ffmpeg(["-y", "-i", file, "-frames:v", "1", "-vf", `scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease`, "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", tmp], true);
    return (await readFile(tmp)).toString("base64");
  } catch {
    return null;
  } finally {
    await rm(tmp, { force: true });
  }
}
