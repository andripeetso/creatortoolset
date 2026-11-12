import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { vpdqHashes } from "./vpdq";

/**
 * The library's `fingerprint` job (tasks/media-library-plan.md, sections 5 and 10): a 64-bit perceptual hash (DCT
 * pHash of a 32×32 grey frame, 16 hex) for every second of the video, plus its vPDQ frame hashes
 * (vpdq.ts) when the PDQ tool is installed. Stored inline in `derivatives`, where the duplicate
 * check reads it. No AI, nothing leaves the server.
 */

export interface Fingerprint {
  /** one pHash per second, from zero */
  phash: string[];
  /** the vPDQ sample; absent when the PDQ tool is not installed */
  pdq?: { interval: number; frames: { hash: string; quality: number }[] };
}

const N = 32;
const K = 8;
// COS[u][x] = cos((2x + 1)uπ / 2N), the DCT-II basis for the low K frequencies
const COS = Array.from({ length: K }, (_, u) => Float64Array.from({ length: N }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))));

/** pHash of one 32×32 grey frame: the low 8×8 DCT coefficients, each bit = above their median (DC left out of it). */
export function phash(gray: Uint8Array): string {
  if (gray.length !== N * N) throw new Error("pHash needs a 32×32 grey frame");
  const rows = new Float64Array(K * N); // rows[u][y] = Σx px[y][x]·COS[u][x]
  for (let u = 0; u < K; u++)
    for (let y = 0; y < N; y++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += gray[y * N + x]! * COS[u]![x]!;
      rows[u * N + y] = s;
    }
  const c: number[] = [];
  for (let v = 0; v < K; v++)
    for (let u = 0; u < K; u++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += rows[u * N + y]! * COS[v]![y]!;
      c.push(s);
    }
  const sorted = c.slice(1).sort((a, b) => a - b);
  const median = (sorted[31]! + sorted[32]!) / 2;
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += ((+(c[i]! > median) << 3) | (+(c[i + 1]! > median) << 2) | (+(c[i + 2]! > median) << 1) | +(c[i + 3]! > median)).toString(16);
  return hex;
}

/** Bits that differ between two pHashes (0 = same picture, 64 = opposite). */
export function phashDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    for (; x; x &= x - 1) d++;
  }
  return d;
}

/** One pHash per second of the first video track: ffmpeg streams 32×32 grey frames, each hashed as it arrives. */
export function phashPerSecond(src: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    // a remote video (a posted reel's URL) gets a read timeout, so a stalled download cannot hang the check
    const remote = /^https?:\/\//.test(src) ? ["-rw_timeout", "30000000"] : [];
    const p = spawn(ffmpegCommand(), [
      "-hide_banner", "-loglevel", "error", "-nostdin", ...remote, "-i", src, "-map", "0:V:0", "-an",
      "-vf", `fps=1,scale=${N}:${N}:flags=area,format=gray`, "-f", "rawvideo", "pipe:1",
    ]);
    const out: string[] = [];
    let carry = Buffer.alloc(0);
    let err = "";
    p.stdout.on("data", (d: Buffer) => {
      let buf = carry.length ? Buffer.concat([carry, d]) : d;
      for (; buf.length >= N * N; buf = buf.subarray(N * N)) out.push(phash(buf.subarray(0, N * N)));
      carry = Buffer.from(buf);
    });
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-2000)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
  });
}

/** The fingerprint of one version's source. `scratch` holds the vPDQ frames for the moment they exist. */
export async function fingerprint(src: string, duration: number, scratch: string): Promise<Fingerprint> {
  const phashes = await phashPerSecond(src);
  const hasher = path.resolve(process.env.FINGERPRINT_BIN_DIR || "runtime/fingerprints", "pdq-photo-hasher");
  if (!(await access(hasher, constants.X_OK).then(() => true, () => false))) return { phash: phashes };
  const dir = await mkdtemp(path.join(scratch, "fingerprint-"));
  try {
    // ponytail: 30 min to decode one video for vPDQ; past that (or any vPDQ error) the pHashes are stored alone
    const pdq = await vpdqHashes(src, Math.max(duration, 1), dir, ffmpegCommand(), hasher, "vpdq", undefined, 30 * 60_000);
    return { phash: phashes, pdq };
  } catch {
    return { phash: phashes };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
