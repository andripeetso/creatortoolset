import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dropTask, startTask, taskFor, taskWaitLine } from "../work/tasks";

/**
 * A frame of a video as a JPEG, made by the `frame` computer task (work/tasks/frames.ts): on one of the person's
 * computers, or here where the server's video work is on. A frame already made is served at once.
 */

export type FrameErrorCode = "NO_VIDEO" | "FFMPEG_UNAVAILABLE" | "EXTRACTION_FAILED";

export class ClipFrameError extends Error {
  constructor(
    readonly code: FrameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClipFrameError";
  }
}

export interface FrameInput {
  /** the video (or still) where the server has it */
  files: { src?: string };
  /** where computer `device` has it itself */
  paths?: { src?: string };
  device?: string;
  atMs: number;
  /** a still: no seek */
  still?: boolean;
  vf?: string;
  q?: number;
  /** where the server keeps the JPEG */
  to: string;
  /** a frame cache to keep small after */
  prune?: string;
  /** what the tool does with it once it is here (whenFramed), with what it needs */
  then?: string;
  data?: Record<string, unknown>;
}

/** A still made smaller or into another format: `out` names the encoder, `ext` the file. */
export interface PictureInput {
  files: { src: string };
  vf?: string;
  out: string[];
  ext: string;
  to: string;
}

const after = new Map<string, (input: FrameInput) => Promise<void> | void>();

/** What a tool does with a frame that came later (a computer made it): set a cover, add a picture. */
export function whenFramed(name: string, fn: (input: FrameInput) => Promise<void> | void): void {
  after.set(name, fn);
}

/** The frame task's apply: the tool's own step for it. */
export async function framed(input: FrameInput): Promise<void> {
  if (input.then) await after.get(input.then)?.(input);
}

/** Said while a computer that can take it is about to. */
export const FRAME_SOON = "Your computer is making it now";

/**
 * The frame `input` asks for, as JPEG bytes, or `wait`: the line it waits with (it is queued for a computer, and the
 * tool's `then` gets it when it comes). `cached`: a JPEG already at `to` is the answer. A failure here throws.
 */
export async function frameAt(ref: string, actor: string, workspace: string | null, input: FrameInput, cached = false): Promise<{ jpeg: Buffer } | { wait: string }> {
  if (cached && existsSync(input.to) && (await stat(input.to)).size) return { jpeg: await readFile(input.to) };
  if (!(input.files.src && existsSync(input.files.src)) && !input.paths?.src) throw new ClipFrameError("NO_VIDEO", "Recording media is missing.");
  const r = await startTask("frame", ref, actor, workspace, input);
  if (r.state === "queued") return { wait: r.line ?? FRAME_SOON };
  // a frame with a `then` was taken by its tool's step already
  return { jpeg: input.then ? Buffer.alloc(0) : await readFile(input.to) };
}

/** A still made into `to` by the `picture` task (always here: a picture, decision 14); false when it cannot be read. */
export async function pictureInto(actor: string, input: PictureInput): Promise<boolean> {
  try {
    const r = await startTask("picture", input.to, actor, null, input);
    return r.state === "done" && existsSync(input.to);
  } catch {
    return false;
  } finally {
    dropTask("picture", input.to);
  }
}

/** The line a frame task `ref` waits with while it is queued for a computer. */
export function frameWaits(ref: string): string | undefined {
  const t = taskFor("frame", ref);
  return t?.state === "queued" ? (taskWaitLine(t) ?? FRAME_SOON) : undefined;
}
