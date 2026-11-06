import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { editOptionsSchema } from "../../contracts/clean-edit";
import { measureFingerprints, runFingerprintTool } from "./clean-fingerprints";
import { quickScore } from "./clean-score";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { sscdDescriptor } from "./clean-sscd";

const native =
  existsSync("runtime/fingerprints/pdq-photo-hasher") &&
  existsSync("runtime/sscd/sscd.onnx");
it.skipIf(!native)(
  "measures real decoded files and reuses source embeddings for live edits",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "extended-clean-test-"));
    const file = path.join(root, "sample.mp4"),
      signal = new AbortController().signal;
    try {
      await runFingerprintTool(ffmpegCommand(), [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=15:duration=2",
        "-c:v",
        "mpeg4",
        file,
      ]);
      const report = await measureFingerprints(file, file, undefined, signal);
      expect(report.sscd?.status).toBe("ok");
      if (report.sscd?.status === "ok")
        expect(report.sscd.meanSimilarity).toBeCloseTo(1, 5);
      expect(report.visual?.status).toBe("ok");
      if (report.visual?.status === "ok")
        expect(report.visual.colorDeltaE).toBe(0);
      expect(report.vpdq?.status).toBe("ok");
      if (report.vpdq?.status === "ok") {
        expect(report.vpdq.before.percent).toBe(100);
        expect(report.vpdq.after.percent).toBe(100);
      }
      expect(report.comparison?.status).toBe("ok");
      if (report.comparison?.status === "ok") {
        expect(report.comparison.samples.length).toBeGreaterThan(0);
        expect(
          report.comparison.samples.every(
            (sample) => sample.sourceStart !== null,
          ),
        ).toBe(true);
        expect(
          report.comparison.samples.every((sample) => sample.distance === 0),
        ).toBe(true);
      }
      expect(report.motion?.status).toBe("ok");
      if (report.motion?.status === "ok")
        expect(report.motion.before).toEqual(report.motion.after);
      const options = editOptionsSchema.parse({ adjustments: {} });
      const info = { width: 320, height: 180, duration: 2 };
      const fast = await quickScore(file, options, info, signal);
      expect(fast.pdq.status).toBe("ok");
      expect(fast.visual?.status).toBe("ok");
      const semantic = await quickScore(file, options, info, signal, "sscd");
      expect(semantic.sscd?.status).toBe("ok");
      options.adjustments.saturation = 0;
      const edited = await quickScore(file, options, info, signal, "sscd");
      expect(edited.cachedFrames).toBe(2);
      if (edited.sscd?.status === "ok")
        expect(edited.sscd.meanSimilarity).toBeLessThan(1);
      expect(
        (await readdir(path.join(root, ".sscd-cache"))).filter((n) =>
          n.startsWith("run-"),
        ),
      ).toHaveLength(0);
      const changed = await quickScore(file, options, info, signal);
      if (changed.visual?.status === "ok")
        expect(changed.visual.colorDeltaE).toBeGreaterThan(10);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

it("does not start a cancelled SSCD inference", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    sscdDescriptor(
      { width: 1, height: 1, data: new Uint8Array(3) },
      controller.signal,
    ),
  ).rejects.toThrow();
});
