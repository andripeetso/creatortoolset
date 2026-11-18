import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants, copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { CaptionRenderSpec } from "../../../src/lib/types";
import { createCaptionFrameRenderer } from "../../caption-frames";
import { filterEscape, requireFontsDir } from "../../export";
import { ffmpegCommand } from "../../ffmpeg-runtime";
import { env } from "../../lib/env";
import { taskKind } from "../tasks";

/**
 * A Caption Studio export (api/exports.ts) as a computer task: the native engine burns the client-built ASS with
 * ffmpeg/libass; the wysiwyg engine draws each caption frame in headless Chromium (caption-frames.ts) and pipes the PNGs
 * to ffmpeg. The same code runs on the server (This Mac, or its video work on) and on a computer, which also keeps the
 * file in its Exports folder (Settings → Folders). Either way the server gets the file through apply, for its download
 * and Finals. Progress and Cancel go through the `progress` call: its answer stops a render whose job was removed.
 */

export const EXPORT_TASK = "export";

export interface ExportInput {
  /** the export job's id (api/exports.ts); the task's ref */
  id: string;
  kind: "burn" | "overlay";
  engine: "native" | "wysiwyg";
  format: string;
  ext: string;
  filename: string;
  width?: number;
  height?: number;
  fps?: number;
  duration: number;
  crf?: number;
  /** where this machine has an input itself (tasks.ts): else `source`, `captions` or `render` come from the server */
  paths?: Record<string, string>;
}

/** The server's copies of a job's inputs, in its export folder: the clip as a link to the original, the ASS, the frame spec. */
const exportInputs = (id: string) => {
  const dir = path.join(env.dataDir, "exports", id);
  return { source: path.join(dir, "source"), captions: path.join(dir, "captions.ass"), render: path.join(dir, "render.json") };
};

/** Alpha samples below this are visibly non-opaque after 8-bit conversion. */
const OPAQUE_THRESHOLD = 250;

export function hasTransparentPixels(alpha: Uint8Array): boolean {
  return alpha.length > 0 && alpha.some((value) => value < OPAQUE_THRESHOLD);
}

type Progress = (p: number, note?: string | null) => Promise<void>;

/** Runs ffmpeg; `onOut` reads its stdout (the -progress stream), `feed` writes its stdin. Killed when `signal` aborts. */
function ffmpeg(args: string[], signal: AbortSignal, o: { onOut?: (s: string) => void; feed?: (stdin: NodeJS.WritableStream) => Promise<void> } = {}): Promise<Buffer> {
  const p = spawn(ffmpegCommand(), args, { stdio: [o.feed ? "pipe" : "ignore", "pipe", "pipe"], signal, killSignal: "SIGKILL" });
  let err = "";
  const out: Buffer[] = [];
  p.stderr!.on("data", (d) => {
    err += d.toString();
    if (err.length > 8000) err = err.slice(-8000);
  });
  // an unread pipe can block ffmpeg at the end
  p.stdout!.on("data", (d: Buffer) => (o.onOut ? o.onOut(d.toString()) : out.push(d)));
  const closed = new Promise<Buffer>((resolve, reject) => {
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${err}`))));
    p.on("error", reject);
  });
  // ffmpeg can end before the frames being written are: the awaited promise below still carries its error
  void closed.catch(() => {});
  if (!o.feed) return closed;
  return o.feed(p.stdin!).then(
    () => (p.stdin!.end(), closed),
    async (e) => {
      p.stdin?.destroy();
      if (p.exitCode === null) p.kill("SIGKILL");
      await closed.catch(() => {});
      throw e;
    },
  );
}

const run = (cmd: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 4000) err = err.slice(-4000);
    });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err}`))));
    p.on("error", reject);
  });

/**
 * Decode a small alpha-plane sample from the finished MOV. ProRes 4444 can carry an alpha-capable pixel format while
 * every encoded alpha value is still opaque, so probing stream metadata alone is not enough.
 */
async function assertMovHasTransparency(file: string, signal: AbortSignal): Promise<void> {
  const alpha = await ffmpeg(
    ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "alphaextract,scale=16:16:flags=neighbor,format=gray", "-frames:v", "1", "-f", "rawvideo", "pipe:1"],
    signal,
  ).catch((e: Error) => {
    throw new Error(`ProRes 4444 output has no usable transparency (${e.message})`);
  });
  if (!hasTransparentPixels(alpha)) throw new Error("ProRes 4444 output has no usable transparency");
}

const QUIET = ["-hide_banner", "-loglevel", "error", "-nostats", "-y"];

/** Native: one ffmpeg pass over the ASS (libass draws text and pill, no browser); progress from ffmpeg's own stream. */
function native(input: ExportInput, args: string[], signal: AbortSignal, progress: Progress): Promise<Buffer> {
  return ffmpeg([...QUIET, ...args, "-progress", "pipe:1"], signal, {
    onOut: (s) => {
      // out_time_ms is actually microseconds in ffmpeg's progress stream
      const m = /out_time_ms=(\d+)/.exec(s);
      if (m) void progress(Math.min(Number(m[1]) / 1e6 / input.duration, 0.99));
    },
  });
}

/** Wysiwyg: the editor's transparent render surface captured per frame, the PNGs streamed to ffmpeg in display order. */
async function rendered(input: ExportInput, spec: CaptionRenderSpec, args: string[], signal: AbortSignal, progress: Progress): Promise<void> {
  let noted = false;
  const renderer = await createCaptionFrameRenderer(spec, () => {
    noted = true;
    void progress(0, "Preparing the Exact export (196 MB download)…");
  });
  if (noted) await progress(0, null);
  const fps = input.fps ?? 30;
  const total = Math.max(1, Math.ceil(input.duration * fps));
  try {
    await ffmpeg([...QUIET, ...args, "-progress", "pipe:1"], signal, {
      onOut: () => {},
      feed: async (stdin) => {
        for (let start = 0; start < total; start += renderer.capacity) {
          if (signal.aborted) throw new Error("Export cancelled");
          const end = Math.min(total, start + renderer.capacity);
          const frames = await renderer.render(Array.from({ length: end - start }, (_, i) => (start + i) / fps));
          for (const frame of frames) if (!stdin.write(frame)) await once(stdin, "drain");
          void progress(Math.min(end / total, 0.99));
        }
      },
    });
  } finally {
    await renderer.close();
  }
}

/** A computer keeps its own copy in its Exports folder for the job's workspace, under the job's name (never over a file). */
async function keepInExports(input: ExportInput, file: string, folder: string): Promise<void> {
  const ext = path.extname(input.filename);
  const stem = input.filename.slice(0, input.filename.length - ext.length);
  await mkdir(folder, { recursive: true });
  for (let k = 1; k < 100; k++) {
    try {
      return await copyFile(file, path.join(folder, k === 1 ? input.filename : `${stem}-${k}${ext}`), constants.COPYFILE_EXCL);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

const codecOf = (input: ExportInput) =>
  input.format === "h265"
    ? ["-c:v", "libx265", "-preset", "medium", "-crf", String(input.crf ?? 22), "-tag:v", "hvc1"]
    : ["-c:v", "libx264", "-preset", "medium", "-crf", String(input.crf ?? 19)];
const PRORES = ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16", "-tag:v", "ap4h", "-an", "-vendor", "apl0", "-movflags", "+faststart"];
const VP9 = ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-crf", "24", "-b:v", "2M", "-cpu-used", "5", "-row-mt", "1", "-deadline", "good", "-an"];
const BURN_OUT = ["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];

taskKind<ExportInput, null>(EXPORT_TASK, {
  serve: (t, name) => (name === "source" || name === "captions" || name === "render" ? exportInputs((t.input as ExportInput).id)[name] : undefined),
  // the browser that draws the frames comes with the Mac app (downloaded on its first export); never another computer
  can: (d, t) => t.input.engine !== "wysiwyg" || d.report?.machine?.os === "mac",
  async run(input, ctx) {
    const ac = new AbortController();
    ctx.signal.addEventListener("abort", () => ac.abort(), { once: true });
    const signal = ac.signal;
    let last = 0;
    const progress: Progress = async (p, note) => {
      if (note === undefined && p > 0 && Date.now() - last < 500) return;
      last = Date.now();
      const r = (await ctx.call("progress", { progress: p, ...(note !== undefined ? { note } : {}) }).catch(() => null)) as { stop?: boolean } | null;
      if (r?.stop) ac.abort();
    };
    await progress(0);
    const name = `out.${input.ext}`;
    const out = path.join(ctx.dir, name);
    const W = input.width ?? 1920;
    const H = input.height ?? 1080;
    const fps = input.fps ?? 30;
    const framesDir = path.join(ctx.dir, "frames");
    const zipFrames = async () => {
      const frames = await readdir(framesDir);
      if (frames.length === 0) throw new Error("No frames rendered");
      await run("zip", ["-j", "-q", "-X", out, ...frames.map((f) => path.join(framesDir, f))]);
      await rm(framesDir, { recursive: true, force: true }).catch(() => {});
    };
    const source = input.kind === "burn" ? await ctx.file("source") : "";

    if (input.engine === "native") {
      const vf = `ass='${filterEscape(await ctx.file("captions"))}':fontsdir='${filterEscape(requireFontsDir())}'`;
      if (input.kind === "burn") {
        await native(input, ["-i", source, "-vf", vf, ...codecOf(input), ...BURN_OUT, out], signal, progress);
      } else {
        // transparent base; libass draws text + pill with real alpha (alpha=1: the ass filter drops it by default)
        const base = ["-f", "lavfi", "-i", `color=c=black@0.0:size=${W}x${H}:rate=${fps}:d=${input.duration},format=rgba`];
        const vfAlpha = `${vf}:alpha=1`;
        if (input.format === "mov") await native(input, [...base, "-vf", `${vfAlpha},format=yuva444p10le`, ...PRORES, out], signal, progress);
        else if (input.format === "webm") await native(input, [...base, "-vf", vfAlpha, ...VP9, out], signal, progress);
        else {
          await mkdir(framesDir, { recursive: true });
          await native(input, [...base, "-vf", vfAlpha, "-c:v", "png", "-pix_fmt", "rgba", "-start_number", "0", path.join(framesDir, "%05d.png")], signal, progress);
          await zipFrames();
        }
      }
    } else {
      const spec = JSON.parse(await readFile(await ctx.file("render"), "utf-8")) as CaptionRenderSpec;
      const frameInput = ["-f", "image2pipe", "-framerate", String(fps), "-i", "pipe:0"];
      if (input.kind === "burn") {
        await rendered(input, spec, [
          "-i", source, ...frameInput,
          "-filter_complex",
          // sidedata: a clip filmed upright is turned as it is read, and FFmpeg 7.1 still hands its quarter turn on
          // to the file after a filter graph like this one, so every player turned the finished video a second time
          "[0:v][1:v]overlay=0:0:format=auto:eof_action=pass,sidedata=mode=delete:type=DISPLAYMATRIX[v]",
          "-map", "[v]", "-map", "0:a?", "-t", String(input.duration), ...codecOf(input), ...BURN_OUT, out,
        ], signal, progress);
      } else if (input.format === "mov") await rendered(input, spec, [...frameInput, "-vf", "format=yuva444p10le", ...PRORES, out], signal, progress);
      else if (input.format === "webm") await rendered(input, spec, [...frameInput, ...VP9, out], signal, progress);
      else {
        await mkdir(framesDir, { recursive: true });
        await rendered(input, spec, [...frameInput, "-c:v", "png", "-pix_fmt", "rgba", "-start_number", "0", path.join(framesDir, "%05d.png")], signal, progress);
        await zipFrames();
      }
    }
    if (signal.aborted) throw new Error("Export cancelled");
    if (input.kind === "overlay" && input.format === "mov") await assertMovHasTransparency(out, signal);
    if (ctx.where === "computer") {
      // its copy on this computer is a convenience: the server's copy (apply) is what the page downloads
      const folder = (await ctx.call("folder", null).catch(() => null)) as string | null;
      if (folder) await keepInExports(input, out, folder).catch((e) => console.warn("[export] not kept in the Exports folder:", e instanceof Error ? e.message : e));
    }
    return { result: null, files: [name] };
  },
  calls: {
    progress: async (t, body) => (await import("../../exports")).exportProgress(t.input.id, body),
    /** where finished videos go in the Exports folder (Settings → Folders) the holding computer has for the job's workspace, or null */
    folder: async (t) => {
      const { deviceOf } = await import("../../lib/devices");
      const { relayFolders } = await import("../../library/report");
      const d = t.held_by ? deviceOf(t.held_by) : undefined;
      if (!d) return null;
      const all = (await relayFolders(d)).filter((x) => x.use === "exports" && (x.workspaces === "*" || !t.workspace || x.workspaces.includes(t.workspace)));
      // the workspace's own Exports folder before the one for every workspace (contracts/storage.ts exportsOf)
      const f = all.find((x) => x.workspaces !== "*") ?? all[0];
      return f ? f.hostPath : null;
    },
  },
  apply: async (t, _r, files) => (await import("../../exports")).exportRendered(t.input.id, files[`out.${t.input.ext}`]!),
  failed: (t, error) => void import("../../exports").then((m) => m.exportFailed(t.input.id, error)),
});
