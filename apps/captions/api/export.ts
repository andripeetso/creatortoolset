import { Hono } from "hono";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, writeFile, stat, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { assertMovHasTransparency } from "./alpha-video";
import { ffmpegCommand } from "./ffmpeg-runtime";

export const exportApp = new Hono();

const FORMATS = new Set(["mov", "webm", "png"]);

export function resolveFontsDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "public/fonts"),
    path.resolve(import.meta.dirname, "public/fonts"),
    path.resolve(import.meta.dirname, "../public/fonts"),
    "/app/dist/public/fonts",
    "/app/public/fonts",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Renders must never fall back to system fonts silently — captions come
 * out in the wrong typeface/weight and look nothing like the preview.
 */
export function requireFontsDir(): string {
  const dir = resolveFontsDir();
  if (!dir) {
    throw new Error(
      "Caption fonts not found on the server (public/fonts) — rendering would use the wrong fonts. Start the server from the app directory."
    );
  }
  return dir;
}

/** Escape a value for safe use inside an ffmpeg filter expression. */
export function filterEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 4000) err = err.slice(-4000);
    });
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${err}`));
    });
    p.on("error", reject);
  });
}

interface ExportBody {
  ass: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  format: string;
}

exportApp.post("/", async (c) => {
  let body: ExportBody;
  try {
    body = await c.req.json<ExportBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { ass, width, height, fps, duration, format } = body;

  if (typeof ass !== "string" || ass.length === 0 || ass.length > 5_000_000) {
    return c.json({ error: "Invalid ASS payload" }, 400);
  }
  if (!FORMATS.has(format)) {
    return c.json({ error: "Unsupported format" }, 400);
  }
  const W = Math.round(width);
  const H = Math.round(height);
  const FPS = Number(fps);
  const DUR = Number(duration);
  if (!(W >= 16 && W <= 4096 && H >= 16 && H <= 4096)) {
    return c.json({ error: "Invalid resolution" }, 400);
  }
  if (!(FPS >= 1 && FPS <= 120)) return c.json({ error: "Invalid fps" }, 400);
  if (!(DUR > 0 && DUR <= 3600)) return c.json({ error: "Invalid duration" }, 400);

  let fontsDir: string;
  try {
    fontsDir = requireFontsDir();
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
  const dir = await mkdtemp(path.join(tmpdir(), "capexport-"));
  const assPath = path.join(dir, "captions.ass");

  try {
    await writeFile(assPath, ass, "utf-8");

    const fontsOpt = `:fontsdir='${filterEscape(fontsDir)}'`;
    const vf = `subtitles='${filterEscape(assPath)}':alpha=1${fontsOpt}`;
    const lavfi = `color=c=black@0:size=${W}x${H}:rate=${FPS}:duration=${DUR},format=rgba`;

    let outPath: string;
    let contentType: string;
    let outName: string;

    if (format === "mov") {
      outPath = path.join(dir, "captions.mov");
      await run(ffmpegCommand(), [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", lavfi,
        "-vf", `${vf},format=yuva444p10le`,
        "-c:v", "prores_ks", "-profile:v", "4",
        "-pix_fmt", "yuva444p10le",
        "-alpha_bits", "16",
        "-tag:v", "ap4h",
        "-vendor", "apl0", "-movflags", "+faststart",
        outPath,
      ]);
      await assertMovHasTransparency(outPath);
      contentType = "video/quicktime";
      outName = "captions-alpha.mov";
    } else if (format === "webm") {
      outPath = path.join(dir, "captions.webm");
      await run(ffmpegCommand(), [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", lavfi,
        "-vf", vf,
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
        "-auto-alt-ref", "0", "-crf", "24", "-b:v", "2M",
        "-cpu-used", "5", "-row-mt", "1", "-deadline", "good",
        outPath,
      ]);
      contentType = "video/webm";
      outName = "captions-alpha.webm";
    } else {
      // png sequence zipped
      const framesDir = path.join(dir, "frames");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(framesDir);
      await run(ffmpegCommand(), [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", lavfi,
        "-vf", vf,
        "-start_number", "0",
        path.join(framesDir, "%05d.png"),
      ]);
      const frames = await readdir(framesDir);
      if (frames.length === 0) throw new Error("No frames rendered");
      outPath = path.join(dir, "captions.zip");
      await run("zip", ["-j", "-q", "-X", outPath, ...frames.map((f) => path.join(framesDir, f))]);
      contentType = "application/zip";
      outName = "captions-alpha-png.zip";
    }

    const st = await stat(outPath);
    const nodeStream = createReadStream(outPath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

    // cleanup temp dir once the file stream is fully read/closed
    nodeStream.on("close", () => {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    });

    return new Response(webStream, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(st.size),
        "Content-Disposition": `attachment; filename="${outName}"`,
      },
    });
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 500);
  }
});
