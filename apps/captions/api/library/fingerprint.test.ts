import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { fingerprint, phash, phashDistance, phashPerSecond } from "./fingerprint";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-fingerprint-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ff = (args: string[]) => execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe" });
const clip = path.join(dir, "clip.mp4");
const copy = path.join(dir, "copy.mp4");
const other = path.join(dir, "other.mp4");
const mean = (a: string[], b: string[]) => a.reduce((s, h, i) => s + phashDistance(h, b[i]!), 0) / a.length;

beforeAll(() => {
  // three seconds each, made here: nothing large is committed
  ff(["-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
  ff(["-i", clip, "-vf", "scale=160:120", "-c:v", "libx264", "-crf", "38", "-pix_fmt", "yuv420p", copy]); // re-encoded, smaller
  ff(["-f", "lavfi", "-i", "mandelbrot=size=320x240:rate=10", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", other]);
});

describe("pHash", () => {
  it("the same frame is distance 0, its negative far away", () => {
    const frame = Uint8Array.from({ length: 1024 }, (_, i) => ((i % 32) * 8 + Math.floor(i / 32) * 3) % 256);
    expect(phash(frame)).toMatch(/^[0-9a-f]{16}$/);
    expect(phashDistance(phash(frame), phash(Uint8Array.from(frame)))).toBe(0);
    expect(phashDistance(phash(frame), phash(frame.map((p) => 255 - p)))).toBeGreaterThan(48);
  });

  it("one hash per second; a re-encoded copy stays close, another video does not", async () => {
    const [a, b, c] = await Promise.all([clip, copy, other].map(phashPerSecond));
    expect(a).toHaveLength(3);
    expect(mean(a, b)).toBeLessThanOrEqual(10); // measured about 3
    expect(mean(a, c)).toBeGreaterThan(20); // measured about 31
  });

  it("without the Cleaner's PDQ tool the fingerprint is the pHashes alone", async () => {
    process.env.FINGERPRINT_BIN_DIR = path.join(dir, "no-tools");
    try {
      const f = await fingerprint(clip, 3, dir);
      expect(f).toEqual({ phash: expect.any(Array) });
      expect(f.phash).toHaveLength(3);
    } finally {
      delete process.env.FINGERPRINT_BIN_DIR;
    }
  });
});
