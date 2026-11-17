import { spawn } from "node:child_process";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { LIBRARY_LOOK_KIND, type DeviceClaim, type DeviceJob } from "../../contracts/devices";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { env } from "../lib/env";
import { readPicture, SHEET_STRETCHES, stretchSheet } from "../library/look";
import { probe } from "../library/media/probe";
import { SHEET_FORMAT, sheetHashes } from "../library/shots";
import type { client } from "./computer";
import { machineDisks } from "./disks";

/**
 * Shot descriptions on a Linux computer's worker (CT_WORKER, no Mac app): the device job road's `library-look`
 * (contracts/devices.ts LIBRARY_LOOK_KIND, api/library/mac-look.ts), answered as the Mac app's LibraryLookJob.swift
 * answers it, with the server's own picture code (library/look.ts readPicture, stretchSheet; shots.ts sheetHashes), so
 * the sheets are the ones the server's own look makes. The file is read where it is, on a network share this computer
 * connects (disks.ts); the server asks the job's AI from the sheets. The sheets are made in DATA_DIR/looks/<job> and
 * removed once sent: nothing is kept here, so lines written again under a new context read the video again.
 * ponytail: no kept sheets (the Mac's `looks`), add them if re-describes of long files from here get frequent
 */

/**
 * Only a Linux computer's worker run for library work (CT_WORKER_KINDS=library, its service file) claims looks: a Mac
 * takes them in its app, and a claim on the device road declares the device's kinds, which would replace the app's.
 */
export const looksHere = (): boolean => process.platform === "linux" && (process.env.CT_WORKER_KINDS ?? "").split(",").includes("library");

/** The videos a look reads (the extension of the file itself, after its links). */
const VIDEO = /\.(mp4|m4v|mov|mkv|webm|avi|mpe?g|mts|m2ts|mxf|wmv|3gp|flv|dv)$/i;

/** Why a look can't be made here, in words for the person. */
export class Refused extends Error {}
const GONE = new Error("The look is no longer this computer's");

/**
 * The file at `p` when this computer may read it for the server: after its links, a regular video file on one of the
 * network shares it connects (`roots`). Anything else is refused, so a path the server names never reads a file of
 * this computer's own.
 */
export function readable(p: string, roots: string[] = machineDisks().map((d) => d.path)): string {
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    throw new Refused(`The file is not on this computer at ${p}.`);
  }
  const realOr = (r: string) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  };
  if (!roots.some((r) => real.startsWith(realOr(r).replace(/\/+$/, "") + "/"))) throw new Refused(`${p} is not on a network share this computer connects.`);
  if (!VIDEO.test(real) || !statSync(real).isFile()) throw new Refused(`${p} is not a video this computer reads.`);
  return real;
}

type Client = ReturnType<typeof client>;

/** Claims a look waiting for this computer and makes it. True when there was one. `roots`: the shares it reads (tests). */
export async function claimLook(c: Client, roots?: string[]): Promise<boolean> {
  const res = await c.raw("editor/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kinds: [LIBRARY_LOOK_KIND] }) });
  const job = ((await res.json().catch(() => null)) as DeviceClaim | null)?.job;
  if (job?.kind !== LIBRARY_LOOK_KIND) return false;
  await runLook(c, job, roots);
  return true;
}

/** Makes one claimed look: the picture read (unless the server sent its stretches), the sheets, the copy to watch, done. */
export async function runLook(c: Client, job: DeviceJob, roots?: string[]): Promise<"done" | "failed" | "gone"> {
  const base = `job/${LIBRARY_LOOK_KIND}/${job.id}`;
  const ctl = new AbortController();
  const send = async (body: unknown, ms = 60_000): Promise<Record<string, unknown>> => {
    const res = await c.raw(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(ms)]) });
    if (res.status === 404 || res.status === 401) {
      ctl.abort(GONE);
      throw GONE;
    }
    const json = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    if (!res.ok) throw new Refused(res.status === 413 ? String(json.error) : `The server refused it: ${String(json.error ?? res.status)}`);
    return json;
  };
  // the server holds the look 5 minutes without a word
  const beat = setInterval(() => void send({ beat: true }).catch(() => {}), 60_000);
  const dir = path.join(env.dataDir, "looks", String(job.id));
  try {
    const o = job.options ?? {};
    if (o.format !== SHEET_FORMAT) throw new Refused("The server asks for sheets this Creator Toolset does not make: update it.");
    const src = readable(o.path ?? "", roots);
    const p = await probe(src);
    let stretches = (JSON.parse(o.stretches || "[]") as [number, number][]).map(([a, b]) => ({ a, b }));
    if (!stretches.length) {
      const read = await readPicture(src, p.fps, ctl.signal);
      const signal = { fps: read.fps, step: Array.from(read.step), cut: Array.from(read.cut), lag: Array.from(read.lag), ...read.odds };
      stretches = ((await send({ signal }, 300_000)).stretches as { a: number; b: number }[] | undefined) ?? [];
      if (!stretches.length) throw new Refused("The server found no stretches in the picture.");
    }
    const duration = Number(o.duration) > 0 ? Number(o.duration) : p.duration;
    const turned = p.rotation === 90 || p.rotation === 270;
    const landscape = (turned ? p.height : p.width) >= (turned ? p.width : p.height);
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < stretches.length; i += SHEET_STRETCHES) {
      const these = stretches.slice(i, i + SHEET_STRETCHES);
      const out = path.join(dir, `${i}.jpg`);
      await stretchSheet(src, these, duration, landscape, out);
      const ph = await sheetHashes(out, these.length, landscape);
      await send({ sheet: { segs: these.map((_, k) => i + k), jpeg: (await readFile(out)).toString("base64"), ph } }, 120_000);
      await rm(out, { force: true });
    }
    const fps = Number(o.watch);
    if (fps > 0) await sendWatchCopy(c, base, src, fps, path.join(dir, "watch.mp4"), ctl.signal);
    await send({ done: true, format: SHEET_FORMAT });
    return "done";
  } catch (e) {
    if (e === GONE || ctl.signal.aborted) return "gone";
    const why = e instanceof Refused ? e.message : `This computer could not read the file's picture: ${e instanceof Error ? e.message : String(e)}.`;
    await c.post(`${base}/fail`, { error: why.slice(0, 500) }).catch(() => {});
    return "failed";
  } finally {
    clearInterval(beat);
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The timeline's small copy (480 lines at most, `fps` frames a second, mono sound), as the Mac makes it, sent to the
 * job's file route. One that can't be made is skipped: the look still finishes.
 */
async function sendWatchCopy(c: Client, base: string, src: string, fps: number, out: string, signal: AbortSignal): Promise<void> {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", src, "-vf", `fps=${Math.max(fps, 1)},scale=-2:'min(480,ih)'`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "30"];
  args.push("-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1", "-b:a", "48k", "-movflags", "+faststart", out);
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn(ffmpegCommand(), args, { stdio: "ignore", signal });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
  if (signal.aborted) throw GONE;
  if (!ok) return void console.warn(`[look] no copy to watch of ${src}`);
  const res = await c.raw(`${base}/file?name=watch.mp4`, {
    method: "POST",
    headers: { "content-type": "video/mp4", "content-length": String(statSync(out).size) },
    body: Readable.toWeb(createReadStream(out)) as ReadableStream,
    signal,
    duplex: "half",
  } as RequestInit);
  if (res.status === 404 || res.status === 401) throw GONE;
}
