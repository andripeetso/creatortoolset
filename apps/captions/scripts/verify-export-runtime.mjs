import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-chromium";

const runtimeFfmpeg = path.resolve(import.meta.dirname, "../runtime/ffmpeg");
const ffmpegPath = process.env.FFMPEG_PATH ||
  (existsSync(runtimeFfmpeg) ? runtimeFfmpeg : "ffmpeg");

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    let error = "";
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => {
      error += chunk.toString();
      if (error.length > 4000) error = error.slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error(`FFmpeg smoke check exited ${code}: ${error}`));
    });
  });
}

await new Promise((resolve, reject) => {
  const child = spawn(ffmpegPath, ["-hide_banner", "-version"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code !== 0) {
      reject(new Error(`FFmpeg smoke check exited ${code}`));
      return;
    }
    if (!/^ffmpeg version .*7\./m.test(output)) {
      reject(new Error("Caption exports require FFmpeg 7.x"));
      return;
    }
    resolve();
  });
});

// Prove the deployed encoder carries pixel-level alpha, not just a 4444
// profile/pixel-format label. This catches runtime builds that silently emit
// an opaque black matte before they can be deployed.
const alphaDir = await mkdtemp(path.join(tmpdir(), "caption-alpha-check-"));
const alphaMov = path.join(alphaDir, "alpha.mov");
try {
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i",
    "color=c=black@0.0:size=64x64:rate=1:d=1,format=rgba,drawbox=x=16:y=16:w=32:h=32:color=white@1:t=fill:replace=1",
    "-vf", "format=yuva444p10le",
    "-frames:v", "1",
    "-c:v", "prores_ks", "-profile:v", "4",
    "-pix_fmt", "yuva444p10le", "-alpha_bits", "16",
    "-tag:v", "ap4h", "-an", alphaMov,
  ]);
  const alpha = await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-i", alphaMov,
    "-vf", "alphaextract,scale=16:16:flags=neighbor,format=gray",
    "-frames:v", "1", "-f", "rawvideo", "pipe:1",
  ]);
  if (alpha.length === 0 || !alpha.some((value) => value < 250)) {
    throw new Error("FFmpeg ProRes 4444 smoke check produced opaque alpha");
  }
} finally {
  await rm(alphaDir, { recursive: true, force: true });
}

const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--allow-file-access-from-files",
    "--disable-dev-shm-usage",
  ],
});
try {
  const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
  const renderer = path.resolve(
    import.meta.dirname,
    "../dist/public/render.html"
  );
  await page.goto(pathToFileURL(renderer).href, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean(globalThis.captionRenderer));
} finally {
  await browser.close();
}

console.log("Export runtime OK (Chromium renderer + FFmpeg 7 ProRes alpha)");
