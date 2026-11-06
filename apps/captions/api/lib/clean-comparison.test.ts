import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { measureFingerprints, runFingerprintTool } from "./clean-fingerprints";
it.skipIf(!existsSync("runtime/fingerprints/pdq-photo-hasher"))(
  "locates real reordered footage after a 1% speed change",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "comparison-timeline-"));
    const source = path.join(root, "source.mp4"),
      edit = path.join(root, "edit.mp4");
    try {
      await runFingerprintTool(ffmpegCommand(), [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=15:duration=8",
        "-filter_complex",
        "[0:v]split[a][b];[a]trim=0:4,setpts=PTS-STARTPTS[x];[b]trim=4:8,setpts=PTS-STARTPTS,hflip[y];[x][y]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        source,
      ]);
      await runFingerprintTool(ffmpegCommand(), [
        "-v",
        "error",
        "-i",
        source,
        "-filter_complex",
        "[0:v]split[a][b];[a]trim=4:8,setpts=PTS-STARTPTS[x];[b]trim=0:4,setpts=PTS-STARTPTS[y];[x][y]concat=n=2:v=1:a=0,setpts=PTS/1.01[v]",
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        edit,
      ]);
      const report = await measureFingerprints(source, edit);
      expect(report.comparison?.status).toBe("ok");
      if (report.comparison?.status === "ok") {
        const samples = report.comparison.samples;

        expect(
          samples
            .filter((s) => s.start < 3)
            .some((s) => s.sourceStart !== null && s.sourceStart >= 4),
        ).toBe(true);
        expect(
          samples
            .filter((s) => s.start >= 4)
            .some((s) => s.sourceStart !== null && s.sourceStart < 4),
        ).toBe(true);
        expect(report.comparison.afterDuration).toBeLessThanOrEqual(
          report.comparison.beforeDuration,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  45_000,
);
