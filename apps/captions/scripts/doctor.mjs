#!/usr/bin/env node
// Checks a running Creator Toolset install and says what is missing or broken.
//   pnpm run doctor                                  checks http://localhost:$PORT (default 3000)
//   pnpm run doctor -- --url http://localhost:43127  checks another address (the dev server)
//   node scripts/doctor.mjs --self-test              the checks' own tests, no network
// (bare `pnpm doctor` is pnpm's own command, so the script is run with `pnpm run`.)
// Reads .env in this folder, then the environment. It never prints a key or a secret.
import "dotenv/config";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const run = promisify(execFile);
const env = process.env;
const TIMEOUT_MS = 8000;
const results = [];
const TAGS = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" };

/** ok | warn | fail | skip. A warn is worth a look; a fail means something will not work. */
export function worst(levels) {
  if (levels.includes("fail")) return "fail";
  if (levels.includes("warn")) return "warn";
  return "ok";
}

/** `ffmpeg -version` starts its first line with "ffmpeg version". */
export function ffmpegOk(output) {
  return /^ffmpeg version /m.test(output);
}

/** S3 is used only when all four of its settings are present (api/media-store.ts). */
export function storageState(e) {
  const keys = ["OBJECT_STORAGE_ENDPOINT", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ACCESS_KEY", "OBJECT_STORAGE_SECRET_KEY"];
  const set = keys.filter((k) => (e[k] ?? "").trim() !== "");
  if (set.length === 0) return "local";
  return set.length === keys.length ? "s3" : "partial";
}

function add(level, name, detail) {
  results.push(level);
  console.log(`[${TAGS[level]}] ${name}: ${detail}`);
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Returns the base address when the server answers, else null. */
async function checkServer(base) {
  let health;
  try {
    health = await getJson(`${base}/api/health`);
  } catch (e) {
    add("fail", "server", `no answer from ${base} (${e.cause?.code ?? e.message}). Is it running? Try docker compose ps, or pnpm dev`);
    return null;
  }
  if (health.status !== 200 || health.body?.ok !== true) {
    add("fail", "server", `${base}/api/health answered ${health.status}, not ok`);
    return null;
  }
  add("ok", "server", `answering at ${base} (up ${health.body.uptimeSec}s, ${health.body.rssMb} MB)`);
  return base;
}

async function checkAccounts(base) {
  const production = env.NODE_ENV === "production";
  const secret = env.APP_SECRET ?? "";
  if (!secret) {
    add(production ? "fail" : "warn", "APP_SECRET",
      production ? "not set: anyone who can reach the site is signed in as admin. Set it in .env and restart"
        : "not set: the app is open to everyone who can reach it (fine on your own machine only)");
  } else if (secret.length < 16) {
    add("warn", "APP_SECRET", "shorter than 16 characters. It is also the first admin's password: use a long random string (openssl rand -base64 32)");
  } else {
    add("ok", "APP_SECRET", "set");
  }
  if (!base) return;
  const check = await getJson(`${base}/api/auth/check`).catch(() => null);
  if (!check?.body) return add("warn", "accounts", `${base}/api/auth/check did not answer`);
  if (check.body.required) add("ok", "accounts", "sign-in is on");
  else add(production ? "fail" : "warn", "accounts",
    "the running server has no APP_SECRET, so it answers without sign-in. Restart it after setting APP_SECRET");
}

async function checkDataDir() {
  const dir = env.DATA_DIR || path.join(homedir(), ".caption-studio");
  const probe = path.join(dir, `.doctor-${randomUUID()}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "ok");
    await unlink(probe);
    add("ok", "data dir", `${dir} is writable`);
  } catch (e) {
    add("fail", "data dir", `${dir} is not writable (${e.code ?? e.message}). In Docker, the /data volume must belong to uid 1000 (the node user)`);
  }
}

async function checkFfmpeg() {
  if (env.FFMPEG_PATH && !existsSync(env.FFMPEG_PATH)) {
    return add("fail", "ffmpeg", `FFMPEG_PATH points to a file that does not exist: ${env.FFMPEG_PATH}`);
  }
  // the same order as api/ffmpeg-runtime.ts: the override, the bundled build, then PATH
  const candidates = [env.FFMPEG_PATH, path.resolve("runtime/ffmpeg"), "ffmpeg"].filter(Boolean);
  for (const bin of candidates) {
    if (bin !== "ffmpeg" && !existsSync(bin)) continue;
    try {
      const { stdout } = await run(bin, ["-version"], { timeout: TIMEOUT_MS });
      if (ffmpegOk(stdout)) return add("ok", "ffmpeg", `${bin}: ${stdout.split("\n")[0].slice(0, 70)}`);
    } catch {
      // not runnable: try the next place
    }
  }
  add("fail", "ffmpeg", "not found. Uploads and exports need it: install ffmpeg (apt install ffmpeg, brew install ffmpeg) or set FFMPEG_PATH");
}

async function checkStorage(dataDir) {
  const state = storageState(env);
  if (state === "local") return add("ok", "storage", `local disk under ${dataDir}. For a private S3-compatible bucket, set the four OBJECT_STORAGE_* values`);
  if (state === "partial") return add("fail", "storage", "set all of OBJECT_STORAGE_ENDPOINT, _BUCKET, _ACCESS_KEY and _SECRET_KEY, or none of them");
  const bucket = env.OBJECT_STORAGE_BUCKET;
  const s3 = new S3Client({
    endpoint: env.OBJECT_STORAGE_ENDPOINT,
    region: env.OBJECT_STORAGE_REGION || "us-east-1",
    forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY, secretAccessKey: env.OBJECT_STORAGE_SECRET_KEY },
  });
  const key = `doctor/${randomUUID()}.txt`;
  try {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "doctor" }));
    const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await got.Body.transformToString();
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    if (text !== "doctor") return add("fail", "storage", `bucket ${bucket} read back different bytes`);
    add("ok", "storage", `bucket ${bucket}: write, read and delete work`);
  } catch (e) {
    add("fail", "storage", `bucket ${bucket} refused the test object (${e.name ?? "error"}). Check the endpoint, the keys, the region and the bucket's CORS rules`);
  }
}

/** Keys that have a free check call. Others are only listed. */
async function checkKeys() {
  const probes = [
    { name: "Anthropic (API budget, Instagram vision, cadence)", key: env.ANTHROPIC_API_KEY,
      url: `${(env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "")}/v1/models`,
      headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }) },
    { name: "Deepgram (cloud transcription)", key: env.DEEPGRAM_API_KEY,
      url: "https://api.deepgram.com/v1/projects", headers: (k) => ({ Authorization: `Token ${k}` }) },
    { name: "ElevenLabs (Audio Enhancer)", key: env.ELEVENLABS_API_KEY,
      url: "https://api.elevenlabs.io/v1/user", headers: (k) => ({ "xi-api-key": k }) },
  ];
  for (const p of probes) {
    if (!p.key?.trim()) { add("skip", p.name, "not set, so that feature is off"); continue; }
    try {
      const { status } = await getJson(p.url, p.headers(p.key.trim()));
      if (status === 200) add("ok", p.name, "key accepted");
      else if (status === 401 || status === 403) add("fail", p.name, `key rejected (HTTP ${status}). Check it in .env`);
      else add("warn", p.name, `answered HTTP ${status}`);
    } catch (e) {
      add("warn", p.name, `could not reach it from here (${e.cause?.code ?? e.message})`);
    }
  }
  for (const [name, key] of [["Perplexity (Workshop accuracy check)", env.PERPLEXITY_API_KEY], ["NVIDIA (Audio Enhancer)", env.NVIDIA_API_KEY]]) {
    if (key?.trim()) add("skip", name, "set, but has no free check call: the app reports errors when it is used");
  }
  add("skip", "AI on a Mac", "not checked here: see Settings → AI providers, which shows each paired Mac and its tools");
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const at = process.argv.indexOf("--url");
  const base = (at > 0 ? process.argv[at + 1] : env.DOCTOR_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, "");
  console.log(`Creator Toolset doctor, checking ${base}\n`);

  const up = await checkServer(base);
  await checkAccounts(up);
  const dataDir = env.DATA_DIR || path.join(homedir(), ".caption-studio");
  await checkDataDir();
  await checkFfmpeg();
  await checkStorage(dataDir);
  await checkKeys();

  const overall = worst(results);
  console.log(`\n${overall === "ok" ? "All checks passed." : overall === "warn" ? "Working, with the warnings above." : "Something needs fixing: the FAIL lines above say what."}`);
  process.exitCode = overall === "fail" ? 1 : 0;
}

function selfTest() {
  assert.equal(worst(["ok", "skip"]), "ok");
  assert.equal(worst(["ok", "warn"]), "warn");
  assert.equal(worst(["ok", "warn", "fail"]), "fail");
  assert.equal(ffmpegOk("ffmpeg version 7.1.5-static\nbuilt with gcc"), true);
  assert.equal(ffmpegOk("bash: ffmpeg: command not found"), false);
  assert.equal(storageState({}), "local");
  assert.equal(storageState({ OBJECT_STORAGE_ENDPOINT: "https://s3.example", OBJECT_STORAGE_BUCKET: "b" }), "partial");
  assert.equal(storageState({
    OBJECT_STORAGE_ENDPOINT: "https://s3.example", OBJECT_STORAGE_BUCKET: "b",
    OBJECT_STORAGE_ACCESS_KEY: "a", OBJECT_STORAGE_SECRET_KEY: "s",
  }), "s3");
  console.log("doctor self-test: ok");
}

main();
