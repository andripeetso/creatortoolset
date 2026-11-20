import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gated } from "../../src/lib/nle/loudness";

const root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "nle-loud-"));
process.env.DATA_DIR = root;
const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { keepLoud, measureLoud, readLoud } = await import("./analyze");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("a source's sound measured for Normalize (measureLoud)", () => {
  it("a mono file measures as it plays in stereo, as ebur128 reads it, and is kept", async () => {
    const wav = path.join(root, "voice.wav");
    // mono: a tone, a quiet stretch, a louder tone
    execFileSync(ffmpegCommand(), ["-v", "error", "-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,3)\\,0.2*sin(2*PI*440*t)\\,if(lt(t\\,5)\\,0.001*sin(2*PI*440*t)\\,0.5*sin(2*PI*700*t))):s=44100:d=8", "-y", wav]);
    const ebu = Number(/I:\s+(-?[\d.]+) LUFS/.exec(spawnSync(ffmpegCommand(), ["-hide_banner", "-nostats", "-i", wav, "-ac", "2", "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { encoding: "utf8" }).stderr)![1]);
    const blocks = await measureLoud(wav);
    expect(blocks.length).toBe(8 * 10 - 3);
    expect(Math.abs(gated(blocks) - ebu)).toBeLessThan(0.2);
    await keepLoud("v1", blocks);
    expect(Array.from((await readLoud("v1"))!)).toEqual(Array.from(blocks));
    expect(await readLoud("v2")).toBeNull();
  });
});
