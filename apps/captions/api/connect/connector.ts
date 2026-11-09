import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { env } from "../lib/env";
import { connectState, saveConnectState } from "./state";

// The tunnel's byte carrier: cloudflared, a pinned release, run by this server as a child process. It connects out to
// Cloudflare and routes the tunnel hostname to this server's loopback origin, so nothing listens on the network. The
// binary is downloaded once into the data folder and its SHA-256 is checked before it is installed, the same
// pinned-runtime pattern as api/ffmpeg-runtime.ts. CT_CLOUDFLARED_PATH overrides it (tests, or a box that has its own).

export const CLOUDFLARED_VERSION = "2026.10.7";
const RELEASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/`;

// process.platform-process.arch → release file and its SHA-256 (the digests on the release page). Darwin ships a .tgz.
export interface Pin {
  file: string;
  sha256: string;
  tgz: boolean;
}
export const PINNED: Record<string, Pin> = {
  "linux-x64": { file: "cloudflared-linux-amd64", sha256: "1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872", tgz: false },
  "linux-arm64": { file: "cloudflared-linux-arm64", sha256: "3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775", tgz: false },
  "darwin-x64": { file: "cloudflared-darwin-amd64.tgz", sha256: "02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848", tgz: true },
  "darwin-arm64": { file: "cloudflared-darwin-arm64.tgz", sha256: "3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd", tgz: true },
};

const execFileAsync = promisify(execFile);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Checks the bytes against the pin and installs the binary at `dest` (atomic rename). Refuses on any mismatch. */
export async function installVerified(bytes: Buffer, pin: Pin, dest: string): Promise<void> {
  if (sha256(bytes) !== pin.sha256) throw new Error("cloudflared checksum mismatch: not installed");
  const dir = path.dirname(dest);
  mkdirSync(dir, { recursive: true });
  const work = mkdtempSync(path.join(dir, ".cf-"));
  try {
    const bin = path.join(work, "cloudflared");
    if (pin.tgz) {
      const archive = path.join(work, "archive.tgz");
      writeFileSync(archive, bytes);
      await execFileAsync("tar", ["-xzf", archive, "-C", work]);
    } else {
      writeFileSync(bin, bytes);
    }
    chmodSync(bin, 0o755);
    renameSync(bin, dest);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The path of a verified cloudflared, downloading it on first use. An installed file is trusted as is, because it can
 * only get there through installVerified. ponytail: no re-hash on every start; add one if the data folder is shared.
 */
export async function ensureCloudflared(fetchImpl: typeof fetch = fetch): Promise<string> {
  const override = process.env.CT_CLOUDFLARED_PATH;
  if (override) {
    if (!existsSync(override)) throw new Error(`CT_CLOUDFLARED_PATH does not exist: ${override}`);
    return override;
  }
  const dest = path.join(env.dataDir, "runtime", "cloudflared");
  if (existsSync(dest)) return dest;
  const key = `${process.platform}-${process.arch}`;
  const pin = PINNED[key];
  if (!pin) throw new Error(`no pinned cloudflared for ${key}`);
  const res = await fetchImpl(RELEASE + pin.file, { redirect: "follow" });
  if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status}`);
  await installVerified(Buffer.from(await res.arrayBuffer()), pin, dest);
  return dest;
}

// The supervisor. One loop per server: it runs cloudflared with the tunnel token, and when it exits for any reason
// other than a stop, it starts it again after a backoff (1 s, doubling to 30 s; back to 1 s after a run of a minute).
let run: Promise<void> | null = null;
let child: ChildProcess | null = null;
let stopping = false;
let starts = 0;
let wake: (() => void) | null = null;

export function connectorStatus(): { running: boolean; pid: number | null; starts: number } {
  return { running: run !== null && !stopping, pid: child?.pid ?? null, starts };
}

/** Starts the tunnel of a linked computer. Does nothing when this computer is not linked or already running. */
export function startConnector(): void {
  const s = connectState();
  if (!s?.tunnelToken || run) return;
  stopping = false;
  const current: Promise<void> = supervise(s.tunnelToken)
    .catch((e: unknown) => console.error("connector:", e instanceof Error ? e.message : e))
    .finally(() => {
      if (run === current) run = null;
    });
  run = current;
}

async function supervise(token: string): Promise<void> {
  const bin = await ensureCloudflared();
  let delay = 1_000;
  while (!stopping) {
    const began = Date.now();
    // The token goes in the environment, not in argv (argv shows in `ps`). Only PATH is passed on, not the server's env.
    const p = spawn(bin, ["tunnel", "--no-autoupdate", "run"], {
      env: { PATH: process.env.PATH ?? "", TUNNEL_TOKEN: token },
      stdio: ["ignore", "ignore", "inherit"],
    });
    child = p;
    starts++;
    await new Promise<void>((resolve) => {
      p.once("exit", () => resolve());
      p.once("error", () => resolve());
    });
    child = null;
    if (stopping) return;
    if (Date.now() - began > 60_000) delay = 1_000;
    console.warn(`connector: cloudflared stopped, starting again in ${delay} ms`);
    await pause(delay);
    delay = Math.min(delay * 2, 30_000);
  }
}

// A pause that stopConnector can cut short.
const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      wake = null;
      resolve();
    }
    wake = done;
  });

/** Stops the tunnel: SIGTERM, SIGKILL after 10 s, and no restart. Resolves once the process is gone. */
export async function stopConnector(): Promise<void> {
  stopping = true;
  wake?.();
  const p = child;
  if (p && p.exitCode === null && p.signalCode === null) {
    const gone = new Promise<void>((resolve) => p.once("exit", () => resolve()));
    p.kill("SIGTERM");
    const killer = setTimeout(() => p.kill("SIGKILL"), 10_000);
    await gone;
    clearTimeout(killer);
  }
  // run clears itself when the supervisor has returned. Clearing it here would let a start during a stop (say, while a
  // download is still pending) run a second supervisor, and a child nobody tracks would outlive unlink.
  await run;
}

/** Unlink on this computer: stop the tunnel and forget the link. The broker's record is removed by its own unlink route. */
export async function unlinkConnector(): Promise<void> {
  await stopConnector();
  saveConnectState(null);
}
