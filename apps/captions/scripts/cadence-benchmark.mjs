#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import dotenv from "dotenv";

dotenv.config();

const [shortVideo, longVideo, runsArg = "10"] = process.argv.slice(2);
const runs = Number(runsArg);
const baseUrl = (process.env.CADENCE_BENCHMARK_URL || "https://creatortoolset.com").replace(/\/$/, "");

if (!shortVideo || !longVideo || !Number.isInteger(runs) || runs < 1) {
  console.error("Usage: node scripts/cadence-benchmark.mjs SHORT_VIDEO LONG_VIDEO [RUNS]");
  process.exit(1);
}
if (!process.env.APP_SECRET) {
  console.error("APP_SECRET is required in .env to authenticate the benchmark.");
  process.exit(1);
}

const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    username: process.env.ADMIN_USERNAME || "admin",
    password: process.env.APP_SECRET,
  }),
});
if (!login.ok) throw new Error(`Benchmark login failed (${login.status})`);
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
if (!cookie) throw new Error("Benchmark login returned no session cookie");

const workDir = await mkdtemp(path.join(tmpdir(), "cadence-benchmark-"));

async function transcribe(label, input) {
  const wav = path.join(workDir, `${label}.wav`);
  const ffmpeg = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
    { stdio: "inherit" },
  );
  if (ffmpeg.status !== 0) throw new Error(`ffmpeg failed for ${label}`);
  const audio = await readFile(wav);
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/transcribe`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "audio/wav" },
    body: audio,
  });
  if (!response.ok) {
    throw new Error(`${label} transcription failed (${response.status}): ${await response.text()}`);
  }
  const data = await response.json();
  const seconds = (performance.now() - startedAt) / 1000;
  console.log(`${label}: transcribed ${data.words.length} words in ${seconds.toFixed(2)}s`);
  return { words: data.words, transcriptionSeconds: seconds };
}

async function cadence(label, words, run) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/ai/segment`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ words, maxChars: 28, maxLines: 1 }),
  });
  const seconds = (performance.now() - startedAt) / 1000;
  if (!response.ok) {
    throw new Error(`${label} cadence run ${run} failed (${response.status}): ${await response.text()}`);
  }
  const data = await response.json();
  console.log(`${label} ${run}/${runs}: ${seconds.toFixed(2)}s (${data.breaks.length} captions)`);
  return { run, seconds, captions: data.breaks.length };
}

function summarize(values) {
  const sorted = values.map((v) => v.seconds).sort((a, b) => a - b);
  const percentile = (p) => {
    const index = (sorted.length - 1) * p;
    const low = Math.floor(index);
    const high = Math.ceil(index);
    return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
  };
  return {
    runs: sorted.length,
    min: sorted[0],
    p10: percentile(0.1),
    p25: percentile(0.25),
    median: percentile(0.5),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p75: percentile(0.75),
    p90: percentile(0.9),
    max: sorted.at(-1),
  };
}

try {
  const short = await transcribe("short", shortVideo);
  const long = await transcribe("long", longVideo);
  const shortRuns = [];
  const longRuns = [];
  for (let run = 1; run <= runs; run++) {
    shortRuns.push(await cadence("short", short.words, run));
    longRuns.push(await cadence("long", long.words, run));
  }
  const report = {
    measuredAt: new Date().toISOString(),
    endpoint: baseUrl,
    capacity: { maxChars: 28, maxLines: 1 },
    short: {
      file: path.basename(shortVideo),
      words: short.words.length,
      transcriptionSeconds: short.transcriptionSeconds,
      runs: shortRuns,
      summary: summarize(shortRuns),
    },
    long: {
      file: path.basename(longVideo),
      words: long.words.length,
      transcriptionSeconds: long.transcriptionSeconds,
      runs: longRuns,
      summary: summarize(longRuns),
    },
  };
  const reportPath = path.join(process.cwd(), "cadence-benchmark-results.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ short: report.short.summary, long: report.long.summary }, null, 2));
  console.log(`Saved ${reportPath}`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
