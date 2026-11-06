import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const runtime = path.resolve(import.meta.dirname, "../runtime");
const tools = path.resolve(process.env.FINGERPRINT_BIN_DIR || path.join(runtime, "fingerprints"));
const bundledFfmpeg = path.join(runtime, "ffmpeg");
const ffmpeg = process.env.FFMPEG_PATH || (existsSync(bundledFfmpeg) ? bundledFfmpeg : "ffmpeg");
const dir = await mkdtemp(path.join(tmpdir(), "caption-fingerprint-check-"));
const run = (command, args) => execFileSync(command, args, {
  cwd: dir, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  // Exercise the deployed decoder, image hasher, video hasher and scorer.
  run("ffprobe", ["-version"]);
  run(ffmpeg, ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
    "testsrc2=size=320x180:rate=15:duration=2", "-c:v", "mpeg4", "sample.mp4"]);
  run(ffmpeg, ["-v", "error", "-nostdin", "-y", "-i", "sample.mp4", "-frames:v", "1",
    "-vf", "scale=512:512:flags=bicubic", "-pix_fmt", "rgb24", "-update", "1", "frame.ppm"]);
  const pdq = run(path.join(tools, "pdq-photo-hasher"), ["frame.ppm"]).trim();
  assert.match(pdq, /^[a-f0-9]{64},\d{1,3},frame\.ppm$/i, "PDQ must produce a valid hash");
  assert.ok(Number(pdq.split(",")[1]) >= 50, "PDQ sample must have sufficient detail");
  assert.equal(run(path.join(tools, "pdq-photo-hasher"), ["frame.ppm"]).trim(), pdq,
    "Repeated PDQ measurements must match");

  // Upstream invokes a shell. Only a fixed local name enters that command.
  let executable = ffmpeg;
  if (!path.isAbsolute(executable)) {
    executable = executable.includes(path.sep) ? path.resolve(executable)
      : (process.env.PATH || "").split(path.delimiter)
        .map((entry) => path.resolve(entry, ffmpeg)).find((entry) => existsSync(entry));
  }
  assert.ok(executable, "FFmpeg must be available");
  await symlink(executable, path.join(dir, "ffmpeg"));
  run(path.join(tools, "tmk-hash-video"), ["-f", "./ffmpeg", "-i", "sample.mp4", "-o", "sample.tmk"]);
  run(path.join(tools, "tmk-hash-video"), ["-f", "./ffmpeg", "-i", "sample.mp4", "-o", "repeat.tmk"]);
  const score = run(path.join(tools, "tmk-two-level-score"), ["--c1", "-1.01", "--c2", "0",
    "sample.tmk", "repeat.tmk"]).trim().split(/\s+/);
  assert.equal(score.length, 4, "TMK must return both scores");
  assert.ok(Math.abs(Number(score[0]) - 1) < 0.00001, "TMK L1 self-similarity must be 1");
  assert.ok(Math.abs(Number(score[1]) - 1) < 0.00001, "TMK L2 self-similarity must be 1");
  console.log("Fingerprint runtime OK (PDQ + TMK+PDQF with generated video)");
} finally {
  await rm(dir, { recursive: true, force: true });
}
