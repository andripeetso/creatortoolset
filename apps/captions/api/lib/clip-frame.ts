import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { awaitTask, dropTask, startTask, taskFor, taskWaitLine } from "../work/tasks";

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
  /** `src`, or for `tile` the numbered pictures (001.png, …) in the order the tile filter lays them */
  files: Record<string, string>;
  vf?: string;
  out: string[];
  ext: string;
  to: string;
  /** a JPEG no longer than `side` and no bigger than `bytes`: the quality goes down, then the size, until it fits */
  fit?: { side: number; bytes: number };
  /** the numbered pictures tiled into one sheet, each 540 wide and `h` high, `cols` × `rows` */
  tile?: { h: number; cols: number; rows: number };
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

/** How long a request waits for one of the person's computers to make a picture it needs now. */
export const PICTURE_WAIT_MS = 60_000;

/**
 * A still made into `to` by the `picture` task: on one of `actor`'s computers, or here where the server's video work is
 * on (a picture is processing too). True when made; else the line why not (no computer can take it now, or it could
 * not be read).
 */
export async function pictureMade(actor: string, input: PictureInput, waitMs = PICTURE_WAIT_MS): Promise<true | string> {
  try {
    const r = await startTask("picture", input.to, actor, null, input);
    if (r.state === "queued") {
      if (r.line) return r.line;
      if ((await awaitTask(r.id, waitMs)) !== "done") return taskFor("picture", input.to)?.state === "failed" ? "That picture could not be read" : FRAME_SOON;
    }
    return existsSync(input.to) || "That picture could not be read";
  } catch {
    return "That picture could not be read";
  } finally {
    dropTask("picture", input.to);
  }
}

/** pictureMade, as made or not. */
export const pictureInto = async (actor: string, input: PictureInput): Promise<boolean> => (await pictureMade(actor, input)) === true;

/** The line a frame task `ref` waits with while it is queued for a computer. */
export function frameWaits(ref: string): string | undefined {
  const t = taskFor("frame", ref);
  return t?.state === "queued" ? (taskWaitLine(t) ?? FRAME_SOON) : undefined;
}
