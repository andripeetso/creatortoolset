import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GenSpec } from "../../contracts/edit-plan";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { generateClip, styleFor, styles } from "./generate";

const W = 90;
const H = 160;
const dir = mkdtempSync(path.join(tmpdir(), "gen-test-"));
const ids = styles().map((s) => s.id);
process.env.FFMPEG_CONCURRENCY = "6";

/** Every frame of a clip as RGB bytes. */
function frames(file: string, w = W, h = H): Buffer[] {
  const raw = execFileSync(ffmpegCommand(), ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 1 << 28,
  });
  const size = w * h * 3;
  return Array.from({ length: raw.length / size }, (_, i) => raw.subarray(i * size, (i + 1) * size));
}

const mean = (f: Buffer, ch?: number) => {
  let s = 0;
  let n = 0;
  for (let i = ch ?? 0; i < f.length; i += ch === undefined ? 1 : 3) (s += f[i]!), n++;
  return s / n;
};
const spread = (f: Buffer) => {
  const m = mean(f);
  let v = 0;
  for (const x of f) v += (x - m) ** 2;
  return Math.sqrt(v / f.length);
};
const diff = (a: Buffer, b: Buffer) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
  return d / a.length;
};

const clip = async (spec: Partial<GenSpec> & { style: string }) =>
  frames((await generateClip({ seconds: 1, ...spec, params: { w: W, h: H, ...spec.params } }, dir)).path);

let loudQuiet = "";
let short = "";
beforeAll(() => {
  // a beat that is loud for a second, then 30 dB quieter for a second
  loudQuiet = path.join(dir, "loud-quiet.wav");
  execFileSync(ffmpegCommand(), [
    "-v", "error", "-y", "-f", "lavfi", "-i",
    "aevalsrc=exprs='0.9*sin(2*PI*(50+80*exp(-30*mod(t,0.25)))*mod(t,0.25))*exp(-8*mod(t,0.25))+0.3*sin(2*PI*330*t)+0.2*sin(2*PI*1800*t)*sin(2*PI*2700*t)':s=44100:d=2",
    "-af", "volume='if(lt(t,1),1,0.03)':eval=frame", "-ac", "2", loudQuiet,
  ]);
  short = path.join(dir, "short.wav");
  execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=220:d=0.5", short]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("generated clips", () => {
  it("offers at least eight styles, each with a line to choose by", () => {
    expect(new Set(ids).size).toBeGreaterThanOrEqual(8);
    for (const s of styles()) expect(s.line.length).toBeGreaterThan(20);
  });

  it("free words land on the nearest style and never throw", () => {
    expect(styleFor("festival visualizations").id).toBe("shapes");
    expect(styleFor("music video visualization").id).toBe("spectrum");
    expect(styleFor("abstract animation").id).toBe("plasma");
    expect(styleFor("PLASMA").id).toBe("plasma");
    expect(styleFor("mandelbrot zoom").id).toBe("fractal");
    for (const w of ["", "zz", "a calm northern sky", "????", "1080p"]) expect(ids).toContain(styleFor(w).id);
  });

  it("every style draws a moving, not flat, picture with no sound, at the length asked", async () => {
    await Promise.all(
      ids.map(async (style) => {
        const fs = await clip({ style, seed: 3 });
        expect(fs.length, style).toBe(30);
        expect(spread(fs[15]!), style).toBeGreaterThan(8);
        expect(diff(fs[3]!, fs[27]!), style).toBeGreaterThan(1);
      }),
    );
  }, 120_000);

  it("every style draws a landscape frame too", async () => {
    await Promise.all(
      ids.map(async (style) => {
        const r = await generateClip({ style, seconds: 0.5, seed: 5, params: { w: H, h: W } }, dir);
        const fs = frames(r.path, H, W);
        expect(fs.length, style).toBe(15);
        expect(spread(fs[10]!), style).toBeGreaterThan(8);
      }),
    );
  }, 120_000);

  it("the same seed gives the same frames, another seed others", async () => {
    await Promise.all(
      ids.map(async (style) => {
        const [a, b, c] = await Promise.all([clip({ style, seed: 7 }), clip({ style, seed: 7 }), clip({ style, seed: 8 })]);
        expect(a.every((f, i) => f.equals(b[i]!)), style).toBe(true);
        expect(diff(a[20]!, c[20]!), style).toBeGreaterThan(0.5);
      }),
    );
  }, 180_000);

  it("the palette sets the colours", async () => {
    await Promise.all(
      ids.map(async (style) => {
        const [red, blue] = await Promise.all([
          clip({ style, seed: 2, palette: ["#000000", "#ff2000"] }),
          clip({ style, seed: 2, palette: ["#000000", "#0020ff"] }),
        ]);
        const avg = (fs: Buffer[], ch: number) => fs.reduce((s, f) => s + mean(f, ch), 0) / fs.length;
        expect(avg(red, 0), style).toBeGreaterThan(avg(red, 2) + 2);
        expect(avg(blue, 2), style).toBeGreaterThan(avg(blue, 0) + 2);
      }),
    );
  }, 120_000);

  it("with a sound, each style is brighter while it is loud than while it is quiet", async () => {
    await Promise.all(
      ids.map(async (style) => {
        const fs = await clip({ style, seconds: 2, seed: 4, audio: loudQuiet });
        const avg = (a: number, b: number) => fs.slice(a, b).reduce((s, f) => s + mean(f), 0) / (b - a);
        expect(avg(10, 28), style).toBeGreaterThan(avg(42, 60) * 1.1);
      }),
    );
  }, 120_000);

  it("audioStartS picks where in the sound the clip starts", async () => {
    await Promise.all(
      ids.map(async (style) => {
        const [fromLoud, fromQuiet] = await Promise.all([
          clip({ style, seconds: 0.8, seed: 4, audio: loudQuiet, audioStartS: 0.1 }),
          clip({ style, seconds: 0.8, seed: 4, audio: loudQuiet, audioStartS: 1.1 }),
        ]);
        const avg = (fs: Buffer[]) => fs.slice(8).reduce((s, f) => s + mean(f), 0) / (fs.length - 8);
        expect(avg(fromLoud), style).toBeGreaterThan(avg(fromQuiet) * 1.1);
      }),
    );
  }, 120_000);

  it("a sound shorter than the clip leaves it full length; bad colours are dropped, not fatal", async () => {
    const r = await generateClip(
      { style: "radial", seconds: 2, audio: short, palette: ["red", "#12345", "#00ff88"], params: { w: W, h: H, fps: 24 } },
      dir,
    );
    expect(r).toMatchObject({ w: W, h: H, fps: 24, seconds: 2 });
    expect(frames(r.path).length).toBe(48);
  }, 60_000);

  it("refuses a sound that is not a file here", async () => {
    await expect(generateClip({ style: "spectrum", seconds: 1, audio: "https://example.com/a.mp3" }, dir)).rejects.toThrow(
      /not a file/,
    );
  });

  it("an abort stops the render and leaves nothing behind", async () => {
    const out = mkdtempSync(path.join(dir, "abort-"));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    await expect(generateClip({ style: "plasma", seconds: 30, params: { w: 1080, h: 1920 } }, out, ac.signal)).rejects.toThrow();
    expect(readdirSync(out)).toEqual([]);
  }, 60_000);
});
