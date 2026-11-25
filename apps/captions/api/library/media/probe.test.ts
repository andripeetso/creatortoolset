import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ffmpegCommand } from "../../ffmpeg-runtime";
import { checkRender, pictureSeconds } from "./probe";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "render-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A 64×64 clip at 10 fps, `secs` long, with a tone when `sound`. */
const clip = (name: string, secs: number, sound: boolean) => {
  const out = path.join(dir, name);
  execFileSync(ffmpegCommand(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc=size=64x64:rate=10:duration=${secs}`,
    ...(sound ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${secs}`, "-c:a", "aac", "-shortest"] : []),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", out,
  ]);
  return out;
};

describe("checkRender", () => {
  it("passes a good 1 s file", async () => {
    expect(await checkRender(clip("good.mp4", 1, true), { duration: 1, sound: true, fps: 10, width: 64, height: 64 })).toEqual({ ok: true });
  });

  it("fails a file cut short", async () => {
    expect(await checkRender(clip("short.mp4", 0.5, true), { duration: 1, sound: true })).toEqual({ ok: false, why: "Video is 0.5 s short" });
  });

  it("fails a silent file when sound is wanted", async () => {
    expect(await checkRender(clip("silent.mp4", 1, false), { duration: 1, sound: true })).toEqual({ ok: false, why: "No sound" });
  });

  it("passes a clip whose sound ends early, measured by its own picture", async () => {
    const out = path.join(dir, "early.mp4");
    execFileSync(ffmpegCommand(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=0.6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out,
    ]);
    expect(await pictureSeconds(out)).toBeCloseTo(1, 1);
    expect(await checkRender(out, { duration: 1, sound: true })).toEqual({ ok: true });
  });

  it("fails the wrong frame count", async () => {
    // 1 s at 10 fps read as 30 fps: the length is right, the frames are a third of them
    expect(await checkRender(clip("ten.mp4", 1, false), { duration: 1, sound: false, fps: 30 })).toEqual({ ok: false, why: "Video has 10 frames, not 30" });
  });

  it("fails a file that is not video", async () => {
    const junk = path.join(dir, "junk.mp4");
    writeFileSync(junk, "not a video");
    expect(await checkRender(junk, { duration: 1, sound: false })).toEqual({ ok: false, why: "File could not be read" });
  });
});
