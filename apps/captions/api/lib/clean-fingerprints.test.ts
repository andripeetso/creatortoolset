import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { measureFingerprints, parsePdq, parseTmk, pdqDistance, runFingerprintTool } from "./clean-fingerprints";

afterEach(() => vi.unstubAllEnvs());
const native = existsSync(path.resolve(process.env.FINGERPRINT_BIN_DIR || "runtime/fingerprints", "tmk-hash-video"))
  && spawnSync("ffmpeg", ["-version"]).status === 0;

describe("fingerprint measurements", () => {
  it("counts all 256 PDQ bits and rejects malformed measurements", () => {
    expect(pdqDistance("0".repeat(64), "f".repeat(64))).toBe(256);
    expect(pdqDistance("a".repeat(64), "a".repeat(64))).toBe(0);
    expect(pdqDistance("0".repeat(64), "0".repeat(63) + "1")).toBe(1);
    expect(() => pdqDistance("00", "11")).toThrow();
    expect(parsePdq(`${"a".repeat(64)},50,before.ppm\n`)).toEqual({ hash: "a".repeat(64), quality: 50 });
    expect(() => parsePdq(`${"a".repeat(64)},101,before.ppm`)).toThrow();
    expect(() => parsePdq("could not decode")).toThrow();
  });

  it("retains negative L1 scores and rejects missing or nonfinite TMK scores", () => {
    expect(parseTmk("-0.3 0.12 before.tmk after.tmk\n")).toEqual({ level1: -0.3, level2: 0.12 });
    for (const text of ["", "nan nan a b", "2 1 a b", "0 0 a b\n1 1 a b"]) expect(() => parseTmk(text)).toThrow();
  });

  it("stops a stalled measurement", async () => {
    await expect(runFingerprintTool(process.execPath, ["-e", "setInterval(() => {}, 1000)"], undefined, 50)).rejects.toThrow("timed out");
  });

  it("reports missing native tools without pretending hashes were measured", async () => {
    vi.stubEnv("FINGERPRINT_BIN_DIR", path.join(tmpdir(), "absent-fingerprint-tools"));
    vi.stubEnv("PATH", "");
    const report = await measureFingerprints("unused.mp4", "unused.mp4");
    expect(report.pdq.status).toBe("unavailable");
    expect(report.tmk.status).toBe("unavailable");
  });

  it.skipIf(!native)("measures identical, different and low-detail clips with the reference binaries", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fingerprint-test-"));
    try {
      const a = path.join(dir, "a video's name.mp4");
      const b = path.join(dir, "b.mp4");
      const black = path.join(dir, "black.mp4");
      for (const [file, source] of [[a, "testsrc2=size=320x180:rate=15:duration=2"], [b, "testsrc=size=320x180:rate=15:duration=2"], [black, "color=black:size=320x180:rate=15:duration=2"]]) {
        const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", source, "-c:v", "mpeg4", file]);
        expect(result.status, result.stderr?.toString()).toBe(0);
      }
      const same = await measureFingerprints(a, a);
      expect(same.pdq.status).toBe("ok");
      expect(same.tmk.status).toBe("ok");
      if (same.pdq.status === "ok") {
        expect(same.pdq.meanDistance).toBe(0);
        expect(same.pdq.frames).toHaveLength(2);
      }
      if (same.tmk.status === "ok") {
        expect(same.tmk.level1).toBeCloseTo(1, 5);
        expect(same.tmk.level2).toBeCloseTo(1, 5);
        expect(same.tmk.signatureIdentical).toBe(true);
      }
      const different = await measureFingerprints(a, b);
      expect(different.pdq.status).toBe("ok");
      expect(different.tmk.status).toBe("ok");
      if (different.pdq.status === "ok") expect(different.pdq.meanDistance).toBeGreaterThan(0);
      if (different.tmk.status === "ok") expect(different.tmk.level2).toBeLessThan(0.99);
      const blank = await measureFingerprints(black, black);
      expect(blank.pdq.status).toBe("ok");
      if (blank.pdq.status === "ok") {
        expect(blank.pdq.reliableFrames).toBe(0);
        expect(blank.pdq.meanDistance).toBeNull();
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);
});
