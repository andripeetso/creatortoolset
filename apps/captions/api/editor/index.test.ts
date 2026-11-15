import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ffmpegCommand } from "../ffmpeg-runtime";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-index-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-index-test-secret";

// the person's AI: a stand-in that answers every numbered shot, counting the calls
const calls: { user: string; images: number }[] = [];
vi.mock("../ai-complete", async (orig) => ({ ...(await orig<typeof import("../ai-complete")>()), aiFor: () => ({}) }));
vi.mock("../ai-vision", () => ({
  completeVisionWithFallback: async (_s: string, user: string, images: unknown[], _sig: unknown, parse: (t: string) => unknown) => {
    calls.push({ user, images: images.length });
    const nums = [...user.matchAll(/(\d+) \(\d+:\d\d–/g)].map((m) => m[1]!);
    const shots = Object.fromEntries(nums.map((n) => [n, `shot ${n}`]));
    return { value: parse(JSON.stringify({ shots, ...(user.includes('"story"') ? { story: "Tiny Acrobatics warm up." } : {}) })), provider: "test" };
  },
}));

const { blobs, libraryDb } = await import("../library/db");
const { beatsOf, decodeMono, describeShots, indexSources, readPicture, shotsOf, songBeats, contactSheet } = await import("./index");

const ff = (args: string[]) => execFileSync(ffmpegCommand(), ["-v", "error", "-y", ...args]);
const at = (f: string) => path.join(dir, f);
const signal = new AbortController().signal;

/** Video parts back to back (each a lavfi source and its length), 25 fps, one H.264 file. */
function clip(out: string, parts: [string, number][]) {
  const ins = parts.flatMap(([src, d]) => ["-t", String(d), "-f", "lavfi", "-i", `${src}=s=320x180:r=25`]);
  const graph = parts.map((_, i) => `[${i}:v]setsar=1,format=yuv420p[v${i}]`).join(";") + ";" + parts.map((_, i) => `[v${i}]`).join("") + `concat=n=${parts.length}:v=1:a=0`;
  ff([...ins, "-filter_complex", graph, "-c:v", "libx264", "-preset", "veryfast", "-g", "250", at(out)]);
}

/** A click track: a short 1 kHz burst on every beat, every fourth one louder, as a WAV (no encoder delay). */
function clicks(out: string, bpm: number, seconds: number) {
  const T = 60 / bpm;
  const expr = `if(lt(mod(t\\,${T})\\,0.015)\\,if(lt(mod(t\\,${4 * T})\\,0.015)\\,0.9\\,0.3)*sin(2*PI*1000*t)*exp(-200*mod(t\\,${T}))\\,0)`;
  ff(["-f", "lavfi", "-i", `aevalsrc=${expr}:s=22050:d=${seconds}`, at(out)]);
}

const nearest = (xs: number[], t: number) => xs.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), Infinity);

beforeAll(() => {
  clip("cuts.mp4", [
    ["testsrc2", 2],
    ["mandelbrot", 1.5],
    ["smptebars", 2],
    ["testsrc2", 2],
  ]);
  clip("still-moving.mp4", [
    ["smptebars", 3],
    ["testsrc2", 3],
  ]);
  clip("still.mp4", [["smptebars", 3]]);
  clicks("click100.wav", 100, 30);
  clicks("click128.wav", 128, 30);
  // 12 s quiet then 12 s loud, a beat in both
  ff(["-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,12)\\,0.03\\,0.6)*(0.5*sin(2*PI*220*t)+if(lt(mod(t\\,0.5)\\,0.02)\\,sin(2*PI*1500*t)\\,0)):s=22050:d=24", at("quiet-loud.wav")]);
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("shots", () => {
  it("finds every hard cut within 2 frames", async () => {
    const shots = shotsOf(await readPicture(at("cuts.mp4"), 25, signal), 7.5);
    expect(shots.map((s) => s.a)).toHaveLength(4);
    const off = [0, 2, 3.5, 5.5].map((want, i) => Math.round(Math.abs(shots[i]!.a - want) * 25 * 100) / 100);
    console.log(`cuts off by ${off.join(", ")} frames`);
    for (const f of off) expect(f).toBeLessThanOrEqual(2);
    expect(shots.at(-1)!.b).toBe(7.5);
  });

  it("orders motion: still bars below a moving pattern, and a still source reads near 0", async () => {
    const [still, moving] = shotsOf(await readPicture(at("still-moving.mp4"), 25, signal), 6);
    expect(still!.motion).toBeLessThan(0.1);
    expect(moving!.motion).toBe(1);
    expect(shotsOf(await readPicture(at("still.mp4"), 25, signal), 3)[0]!.motion).toBeLessThan(0.1);
  });

  it("splits a long take into 4–8 s pieces", () => {
    // 30 s at 25 fps with no cut, the picture changing most at 13 s
    const n = 750;
    const step = new Float32Array(n).fill(0.01);
    const lag = new Float32Array(n).fill(0.02);
    for (let i = 320; i < 340; i++) lag[i] = 0.2;
    const shots = shotsOf({ fps: 25, step, lag }, 30);
    for (const s of shots) expect(s.b - s.a).toBeGreaterThanOrEqual(4 - 1e-9), expect(s.b - s.a).toBeLessThanOrEqual(8 + 1e-9);
    expect(shots.some((s) => Math.abs(s.a - 13) < 0.5)).toBe(true);
  });
});

describe("song", () => {
  for (const bpm of [100, 128])
    it(`reads a click track at ${bpm} bpm: tempo, beats, accents`, async () => {
      const s = await songBeats(at(`click${bpm}.wav`), 0, signal);
      const T = 60 / bpm;
      expect(Math.abs(s.bpm - bpm)).toBeLessThanOrEqual(1);
      const want = Array.from({ length: Math.floor(30 / T) }, (_, k) => k * T);
      let worst = 0;
      for (const b of s.beats) worst = Math.max(worst, Math.abs(nearest(want, b) - b));
      expect(worst).toBeLessThanOrEqual(0.02);
      expect(s.beats.length).toBeGreaterThanOrEqual(want.length - 2);
      const accents = want.filter((_, k) => k % 4 === 0);
      for (const a of accents.slice(1, -1)) expect(Math.abs(nearest(s.strong, a) - a)).toBeLessThanOrEqual(0.02);
      for (const t of s.strong) expect(Math.abs(nearest(accents, t) - t)).toBeLessThanOrEqual(0.02); // no quiet click is strong
      for (const d of s.downbeats) expect(Math.abs(nearest(accents, d) - d)).toBeLessThanOrEqual(0.02);
      console.log(`click ${bpm}: bpm ${s.bpm}, worst beat ${(worst * 1000).toFixed(1)} ms, ${s.beats.length} beats, ${s.strong.length} strong`);
    });

  it("keeps the song's own time from a later start", async () => {
    const s = await songBeats(at("click128.wav"), 1, signal);
    const T = 60 / 128;
    expect(s.beats[0]!).toBeGreaterThanOrEqual(1);
    for (const b of s.beats) expect(Math.abs(b / T - Math.round(b / T)) * T).toBeLessThanOrEqual(0.02);
  });

  it("splits quiet then loud into two sections", async () => {
    const x = await decodeMono(at("quiet-loud.wav"), 0, signal);
    const { sections } = beatsOf(x, "quiet-loud.wav", 0);
    expect(sections).toHaveLength(2);
    expect(Math.abs(sections[0]!.b - 12)).toBeLessThanOrEqual(1);
    expect(sections[0]!.energy).toBeLessThan(0.2);
    expect(sections[1]!.energy).toBe(1);
  });
});

describe("index and descriptions", () => {
  async function seed(id: string, title: string, file: string, probe: object, description?: string) {
    const key = `libraries/lib_a/v/${id}/source`;
    copyFileSync(at(file), at(`${id}-${file}`)); // the store takes the file it is given
    await blobs.put(key, at(`${id}-${file}`));
    const d = libraryDb();
    d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, 'mem-a', 0)").run(`a-${id}`, title);
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'mem-a', 0)").run(
      id,
      `a-${id}`,
      key,
      `sha-${id}`,
      JSON.stringify(probe),
    );
    if (description) d.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at) VALUES (?, 'user', ?, NULL, 0)").run(id, description);
  }
  const probe = { width: 320, height: 180, fps: 25, rotation: 0, format: "mov,mp4,m4a,3gp,3g2,mj2", vcodec: "h264", pixFmt: "yuv420p", acodec: "" };

  it("indexes, describes in one call, and asks nothing the second time", async () => {
    libraryDb().exec("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'mem-a', 'A', 'local', 0)");
    await seed("ver_cuts", "Tiny Acrobatics warm-up", "cuts.mp4", { ...probe, duration: 7.5 });
    await seed("ver_still", "Bars", "still.mp4", { ...probe, duration: 3 }, "Colour bars on a screen.");
    const index = await indexSources({ sources: ["ver_cuts", "ver_still"] }, signal);
    expect(index.sources.map((s) => s.shots.length)).toEqual([4, 1]);
    expect(index.sources[0]).toMatchObject({ dur: 7.5, fps: 25, w: 320, h: 180, speech: false });

    const looked = await describeShots(index, { actor: "mem-a", story: true }, signal);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.images).toBe(1); // the bars took the library's words: only the cut clip's sheet went
    expect(looked.sources[0]!.shots.map((s) => s.desc)).toEqual(["shot 1", "shot 2", "shot 3", "shot 4"]);
    expect(looked.sources[1]!.shots[0]!.desc).toBe("Colour bars on a screen.");
    expect(looked.story).toBe("Tiny Acrobatics warm up.");

    const again = await describeShots(await indexSources({ sources: ["ver_cuts", "ver_still"] }, signal), { actor: "mem-a" }, signal);
    expect(calls).toHaveLength(1);
    expect(again.sources[0]!.shots[2]!.desc).toBe("shot 3");
  });

  it("draws a contact sheet", async () => {
    const out = at("sheet.jpg");
    await contactSheet(at("cuts.mp4"), [1, 2.7, 4.5, 6.5, 7], true, out);
    const size = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]).toString().trim();
    expect(size).toBe(`${4 * 264},${2 * 152}`);
  });
});
