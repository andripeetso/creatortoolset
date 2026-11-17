import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlanEffect } from "../../contracts/edit-plan";
import type { Item, Timeline } from "../../contracts/editor";
import { ffmpegCommand } from "../ffmpeg-runtime";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-plan-render-"));
process.env.DATA_DIR = dir;

const { atempo, renderPlanPreview, stretchesOf, stretchFilter, TAIL } = await import("./plan-render");
const { renderPreview } = await import("./preview");
const { emptyTracks } = await import("./timeline");

const tl = (items: Item[] = []): Timeline => {
  const t: Timeline = {
    name: "Run v1",
    fps: 30,
    width: 320,
    height: 180,
    sources: { game: { versionId: "game", name: "Run", fps: 30, tc: 0, dur: 240, w: 320, h: 180 }, song: { versionId: "song", name: "Song", fps: 30, tc: 0, dur: 300, w: 0, h: 0 } },
    tracks: emptyTracks(),
    markers: [],
    plan: { kind: "hard edit" },
  };
  t.tracks.V1.items = items;
  return t;
};
const shot = (fx: PlanEffect[], over: Partial<Item> = {}): Item => ({ src: "game", in: 0, len: 30, rec: 0, link: "c1", fx, ...over });
const graph = (fx: PlanEffect[], over: Partial<Item> = {}, off = 0) => {
  const i = shot(fx, over);
  return stretchFilter(tl([i]), i, { off, frames: 30, speed: i.speed ?? 1 }, 0);
};
const BASE = "setpts=(PTS-STARTPTS)/1,scale=320:180,crop=320:180:0:0,pad=320:180:0:0:black,setsar=1,fps=30/1,format=yuv420p";

describe("a planned shot's filter graph, per effect", () => {
  it("frames the shot as the timeline does, at its speed, with nothing else when it has no effect", () => {
    expect(graph([])).toBe(`${BASE},${TAIL}`);
    expect(graph([], { speed: 2 })).toMatch(/^setpts=\(PTS-STARTPTS\)\/2,scale=320:180,/);
  });

  it("draws punch, zoom and shake as one scale over time and a crop, in the shot's own time", () => {
    expect(graph([{ type: "punch", at: 0.5, amount: 1.4 }])).toBe(
      `${BASE},scale=w='trunc(320*(if(between(t+0,0.5,0.8),1.4-0.4*((t+0)-0.5)/0.3,1))/2)*2':h='trunc(180*(if(between(t+0,0.5,0.8),1.4-0.4*((t+0)-0.5)/0.3,1))/2)*2':eval=frame,crop=320:180:x='(iw-ow)/2':y='(ih-oh)/2',copy,${TAIL}`,
    );
    // a later stretch of the shot counts from its own place in it
    expect(graph([{ type: "zoom", at: 0, dur: 1, from: 1, to: 2 }], {}, 0.4)).toContain("if(lt((t+0.4),0),1,if(lt((t+0.4),1),1+1*((t+0.4)-0)/1,2))");
    const shake = graph([{ type: "shake", at: 0.2, dur: 0.3, amount: 0.5 }]);
    expect(shake).toContain("(1.1)");
    expect(shake).toContain("x='(iw-ow)/2+if(between(t+0,0.2,0.5),16*sin((t+0)*83),0)'");
  });

  it("draws flash, glitch, rgb, blur, invert and strobe each over its own window", () => {
    expect(graph([{ type: "flash", at: 0, dur: 0.2 }])).toContain("eq=brightness='if(between(t+0,0,0.2),1-((t+0)-0)/0.2,0)':eval=frame");
    expect(graph([{ type: "flash", at: 0, dur: 0.2, color: "#ff0040" }])).toContain("drawbox=c=0xff0040@0.85:t=fill:enable='between(t+0,0,0.2)'");
    const glitch = graph([{ type: "glitch", at: 0.1, dur: 0.3, amount: 1 }]);
    expect(glitch).toContain("rgbashift=rh=13:bh=-13:gv=7:enable='between(t+0,0.1,0.4)'");
    expect(glitch).toContain("noise=alls=80:allf=t:enable='between(t+0,0.1,0.4)'");
    expect(graph([{ type: "rgb", at: 0, dur: 1, amount: 0.5 }])).toContain("rgbashift=rh=6:bh=-6:gv=0:enable=");
    expect(graph([{ type: "blur", at: 0, dur: 1, amount: 0.5 }])).toContain("gblur=sigma=13:enable='between(t+0,0,1)'");
    expect(graph([{ type: "invert", at: 0.5, dur: 0.25 }])).toContain("negate=enable='between(t+0,0.5,0.75)'");
    expect(graph([{ type: "strobe", at: 0, dur: 1 }])).toContain("negate=enable='between(t+0,0,1)*lt(mod(n,4),2)'");
  });

  it("draws the entry and the texts that fall on it", () => {
    expect(graph([], { enter: "flash" })).toContain("eq=brightness='if(between(t+0,0,0.12)");
    expect(graph([], { enter: "whip" })).toContain("gblur=sigma=40:sigmaV=0.01:enable='between(t+0,0,0.12)'");
    expect(graph([], { enter: "dissolve" })).toContain("fade=t=in:st=0:d=0.3");
    const i = shot([]);
    const withText = stretchFilter(tl([i]), i, { off: 0, frames: 30, speed: 1 }, 2, { font: "/fonts/A.ttf", texts: [{ at: 2.5, dur: 1, text: "GO", place: "top", file: "/t/0.txt" }] });
    expect(withText).toContain("drawtext=fontfile='/fonts/A.ttf':textfile='/t/0.txt':fontsize=13:");
    expect(withText).toContain("y=h*0.12:enable='between(t+2,2.5,3.5)'");
  });

  it("frames each shot as its frame says, the extra pictures as inputs 2 and 3", () => {
    const t = tl();
    t.sources.wide = { versionId: "wide", name: "Wide", fps: 30, tc: 0, dur: 240, w: 640, h: 180 };
    const g = (over: Partial<Item>, o = {}) => stretchFilter(t, shot([], over), { off: 0, frames: 30, speed: 1 }, 0, o);
    expect(g({ src: "wide", frame: "fit" })).toContain("scale=320:90,crop=320:90:0:0,pad=320:180:0:45:black");
    // a letterbox band of 320/2.39 = 134 rows: 23 black rows above and below
    expect(g({ frame: "letterbox" })).toContain("drawbox=x=0:y=0:w=iw:h=23:c=black:t=fill,drawbox=x=0:y=ih-23:w=iw:h=23:c=black:t=fill");
    expect(g({ src: "wide", frame: "blur" })).toContain("split[pa][pb];[pa]scale=640:180,crop=320:180,gblur=sigma=10,eq=brightness=-0.12[pbg];[pb]scale=320:90[pfg];[pbg][pfg]overlay=x=(W-w)/2:y=(H-h)/2");
    expect(g({ frame: "inset", zoom: 0.5 }, { under: { w: 320, h: 180 } })).toContain("scale=160:90,pad=iw+4:ih+4:2:2:white,setsar=1,fps=30/1,format=yuv420p[fg];[2:v]setpts=(PTS-STARTPTS)/1,scale=320:180,crop=320:180");
    const split = g({ split: [{ src: "game", in: 30 }, { src: "wide", in: 0 }] });
    // three cells of 60 rows stacked into the frame's 180
    expect(split).toContain("scale=320:180,crop=320:60,setsar=1,fps=30/1,format=yuv420p[c0];[2:v]setpts=(PTS-STARTPTS)/1,scale=320:180,crop=320:60,");
    expect(split).toContain("[3:v]setpts=(PTS-STARTPTS)/1,scale=320:90,crop=320:60,");
    expect(split).toContain("[c0][c1][c2]vstack=inputs=3");
  });

  it("draws reverse, stutter, freeze and zoomblur", () => {
    expect(graph([{ type: "reverse" }])).toMatch(/^trim=duration=1\.0333,reverse,setpts=\(PTS-STARTPTS\)\/1,/);
    // a stutter at 0.5 s of a 0.1 s slice played 3 times: 3 frames looped twice; the freeze after it counts those 6 in
    const g = graph([{ type: "freeze", at: 0.8, dur: 0.2 }, { type: "stutter", at: 0.5, dur: 0.1, amount: 3 }]);
    expect(g).toContain("loop=loop=2:size=3:start=15,loop=loop=6:size=1:start=30,setpts=N*1/30/TB");
    // a later stretch counts from its own place; a loop outside it is not drawn there
    expect(graph([{ type: "freeze", at: 0.2, dur: 0.2 }], {}, 0.4)).not.toContain("loop=");
    const zb = graph([{ type: "zoomblur", at: 0, dur: 0.25, amount: 1 }]);
    expect(zb).toContain("split=3[zb0a][zb0b][zb0c];[zb0b]scale=358:202,crop=320:180[zb0d];[zb0c]scale=396:224,crop=320:180[zb0e];[zb0a][zb0d]blend=all_mode=average:enable='between(t+0,0,0.25)'[zb0f];[zb0f][zb0e]blend=all_mode=average:enable='between(t+0,0,0.25)'");
    expect(zb).toContain("if(between(t+0,0,0.25),1+0.15*(1-((t+0)-0)/0.25),1)");
  });

  it("splits a ramp into steady stretches that play the ramp's source time, and slows sound with atempo", () => {
    const st = stretchesOf({ len: 30, ramp: [{ t: 0, speed: 1 }, { t: 0.5, speed: 0.5 }, { t: 1, speed: 0.5 }] }, 30);
    expect(st.reduce((n, s) => n + s.frames, 0)).toBe(30);
    // the ramp plays 0.375 + 0.25 s of source
    expect(st.reduce((n, s) => n + (s.frames / 30) * s.speed, 0)).toBeCloseTo(0.625, 2);
    expect(stretchesOf({ len: 12, speed: 3 }, 30)).toEqual([{ off: 0, frames: 12, speed: 3 }]);
    expect(atempo(1)).toEqual([]);
    expect(atempo(0.3)).toEqual(["atempo=0.5", "atempo=0.6"]);
    expect(atempo(3)).toEqual(["atempo=3"]);
  });
});

describe("a planned edit drawn", () => {
  const game = path.join(dir, "game.mp4");
  const song = path.join(dir, "song.wav");
  const ff = (...args: string[]) => execFileSync(ffmpegCommand(), ["-v", "error", "-y", ...args]);
  const probe = (file: string, ...args: string[]) => execFileSync(ffmpegCommand().replace(/ffmpeg$/, "ffprobe"), ["-v", "error", ...args, file], { encoding: "utf8" }).trim();
  const frame = (file: string, n: number) => execFileSync(ffmpegCommand(), ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  const mean = (b: Buffer) => b.reduce((n, x) => n + x, 0) / b.length;
  beforeAll(() => {
    ff("-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=8", "-f", "lavfi", "-i", "sine=f=440:d=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", game);
    ff("-f", "lavfi", "-i", "sine=f=880:d=10", song);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("renders every effect and a ramp to the frame, with the song under it, through the preview's own entry", async () => {
    const items: Item[] = [
      { src: "game", in: 0, len: 15, rec: 0, link: "c1", fx: [{ type: "flash", at: 0, dur: 0.3 }] },
      { src: "game", in: 30, len: 15, rec: 15, link: "c2", fx: [{ type: "punch", at: 0, amount: 1.5 }, { type: "shake", at: 0, dur: 0.5, amount: 1 }] },
      { src: "game", in: 60, len: 15, rec: 30, link: "c3", fx: [{ type: "glitch", at: 0, dur: 0.5, amount: 1 }, { type: "rgb", at: 0, dur: 0.5 }] },
      { src: "game", in: 90, len: 15, rec: 45, link: "c4", fx: [{ type: "blur", at: 0, dur: 0.5, amount: 1 }, { type: "strobe", at: 0, dur: 0.5 }] },
      { src: "game", in: 120, len: 15, rec: 60, link: "c5", fx: [{ type: "invert", at: 0, dur: 0.5 }, { type: "zoom", at: 0, dur: 0.5, from: 1, to: 2 }], enter: "whip" },
      { src: "game", in: 150, len: 30, rec: 75, link: "c6", ramp: [{ t: 0, speed: 2 }, { t: 1, speed: 0.5 }], enter: "dissolve" },
    ];
    const t = tl(items);
    t.tracks.A1.items = [{ src: "game", in: 30, len: 15, rec: 15, link: "c2", gainDb: -12 }];
    t.tracks.A2.items = [{ src: "song", in: 30, len: 105, rec: 0 }];
    t.plan = { kind: "hard edit", texts: [{ at: 0.2, dur: 1, text: "Tiny Acrobatics", place: "middle" }] };
    const out = path.join(dir, "all.mp4");
    await renderPreview(t, { game, song }, out);
    expect(Number(probe(out, "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"))).toBe(105);
    expect(Math.abs(Number(probe(out, "-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "csv=p=0")) - 3.5)).toBeLessThan(0.06);
    // the flash is white at its start; the inverted shot is darker or lighter than the same frames drawn plainly
    expect(mean(frame(out, 0))).toBeGreaterThan(200);
    const plain = path.join(dir, "plain.mp4");
    await renderPlanPreview(tl([{ src: "game", in: 120, len: 15, rec: 0, link: "c1" }]), { game, song }, plain);
    expect(Math.abs(mean(frame(out, 62)) - mean(frame(plain, 2)))).toBeGreaterThan(10);
  }, 120_000);

  it("draws each frame's geometry: fit, blur, an inset over the shot before, a split, a letterbox", async () => {
    const white = path.join(dir, "white.mp4");
    const black = path.join(dir, "black.mp4");
    ff("-f", "lavfi", "-i", "color=c=white:s=320x180:r=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", white);
    ff("-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", black);
    const src = (id: string) => ({ versionId: id, name: id, fps: 30, tc: 0, dur: 120, w: 320, h: 180 });
    const of = (width: number, height: number, items: Item[]): Timeline => {
      const t: Timeline = { name: "Frames v1", fps: 30, width, height, sources: { white: src("white"), black: src("black") }, tracks: emptyTracks(), markers: [], plan: { kind: "hard edit" } };
      t.tracks.V1.items = items;
      return t;
    };
    // a tall frame (180x320) of wide footage: fitted it is 180x101
    const tall = path.join(dir, "frames.mp4");
    await renderPlanPreview(
      of(180, 320, [
        { src: "white", in: 0, len: 6, rec: 0, frame: "fit" },
        { src: "white", in: 6, len: 6, rec: 6, frame: "blur" },
        { src: "black", in: 0, len: 6, rec: 12 },
        { src: "white", in: 12, len: 6, rec: 18, frame: "inset", zoom: 0.5 },
        { src: "black", in: 6, len: 6, rec: 24, split: [{ src: "white", in: 18 }, { src: "black", in: 12 }] },
      ]),
      { white, black },
      tall,
    );
    const px = (b: Buffer, w: number, x: number, y: number) => b[y * w + x]!;
    const fit = frame(tall, 3);
    expect(px(fit, 180, 90, 10)).toBeLessThan(30);
    expect(px(fit, 180, 90, 160)).toBeGreaterThan(220);
    // whole over a blurred copy: the band above the picture is lit, not black
    expect(px(frame(tall, 9), 180, 90, 10)).toBeGreaterThan(120);
    // half the width, over the black shot before it
    const inset = frame(tall, 21);
    expect(px(inset, 180, 90, 160)).toBeGreaterThan(220);
    expect(px(inset, 180, 10, 160)).toBeLessThan(30);
    // three cells of 106, 106 and 108 rows: the middle one white
    const split = frame(tall, 27);
    expect(px(split, 180, 90, 50)).toBeLessThan(30);
    expect(px(split, 180, 90, 160)).toBeGreaterThan(220);
    expect(px(split, 180, 90, 270)).toBeLessThan(30);
    const wide = path.join(dir, "letterbox.mp4");
    await renderPlanPreview(of(320, 180, [{ src: "white", in: 0, len: 6, rec: 0, frame: "letterbox" }]), { white, black }, wide);
    const lb = frame(wide, 3);
    expect(px(lb, 320, 160, 8)).toBeLessThan(30);
    expect(px(lb, 320, 160, 90)).toBeGreaterThan(220);
  }, 120_000);

  it("plays a shot backwards, repeats a stutter's slice, holds a freeze, and keeps the shot's length", async () => {
    const run = async (name: string, fx: PlanEffect[]) => {
      const out = path.join(dir, `${name}.mp4`);
      await renderPlanPreview(tl([{ src: "game", in: 30, len: 30, rec: 0, link: "c1", fx }]), { game, song }, out);
      expect(Number(probe(out, "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"))).toBe(30);
      return out;
    };
    const diff = (a: Buffer, b: Buffer) => a.reduce((n, x, i) => n + Math.abs(x - b[i]!), 0) / a.length;
    const plain = await run("plain", []);
    // backwards: its first frame is the plain shot's last
    expect(diff(frame(await run("reverse", [{ type: "reverse" }]), 0), frame(plain, 29))).toBeLessThan(diff(frame(plain, 0), frame(plain, 29)) / 3);
    // a 3-frame slice from frame 9 played three times: frame 12 is frame 9 again
    const st = await run("stutter", [{ type: "stutter", at: 0.3, dur: 0.1, amount: 3 }]);
    expect(diff(frame(st, 12), frame(st, 9))).toBeLessThan(diff(frame(plain, 12), frame(plain, 9)) / 2);
    const fr = await run("freeze", [{ type: "freeze", at: 0.2, dur: 0.3 }]);
    expect(diff(frame(fr, 6), frame(fr, 14))).toBeLessThan(diff(frame(plain, 6), frame(plain, 14)) / 2);
    expect(diff(frame(await run("zoomblur", [{ type: "zoomblur", at: 0, dur: 0.5, amount: 1 }]), 2), frame(plain, 2))).toBeGreaterThan(2);
  }, 120_000);
});

describe("the sound effects on A3 are heard in the preview", () => {
  const sdir = path.join(dir, "a3");
  const game = path.join(sdir, "game.mp4");
  const beep = path.join(sdir, "beep.wav");
  const ff = (...args: string[]) => execFileSync(ffmpegCommand(), ["-v", "error", "-y", ...args]);
  // the RMS level of the sound in [from, to) seconds, mono
  const level = (file: string, from: number, to: number) => {
    const b = execFileSync(ffmpegCommand(), ["-v", "error", "-ss", String(from), "-t", String(to - from), "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 1 << 26 });
    let sum = 0;
    for (let i = 0; i + 1 < b.length; i += 2) sum += (b.readInt16LE(i) / 32768) ** 2;
    return Math.sqrt(sum / (b.length / 2));
  };
  // one silent 3 s shot, and a 0.5 s beep on A3 at 1 s
  const timeline = (plan: boolean): Timeline => {
    const t: Timeline = {
      name: "Run v1",
      fps: 30,
      width: 320,
      height: 180,
      sources: {
        game: { versionId: "game", name: "Run", fps: 30, tc: 0, dur: 90, w: 320, h: 180 },
        beep: { versionId: "beep", name: "Beep", fps: 30, tc: 0, dur: 15, w: 0, h: 0 },
      },
      tracks: emptyTracks(),
      markers: [],
    };
    t.tracks.V1.items = [{ src: "game", in: 0, len: 90, rec: 0, link: "c1" }];
    t.tracks.A3.items = [{ src: "beep", in: 0, len: 15, rec: 30, gainDb: -12 }];
    if (plan) t.plan = { kind: "hard edit" };
    return t;
  };
  beforeAll(() => {
    mkdirSync(sdir, { recursive: true });
    ff("-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", game);
    ff("-f", "lavfi", "-i", "sine=f=1000:d=0.5", beep);
  }, 60_000);
  afterAll(() => rmSync(sdir, { recursive: true, force: true }));

  it("mixes A3 into a planned cut and into a draft, at its place and nowhere else", async () => {
    for (const plan of [true, false]) {
      const out = path.join(sdir, `${plan ? "plan" : "draft"}.mp4`);
      await renderPreview(timeline(plan), { game, beep }, out);
      expect(level(out, 0.05, 0.9)).toBeLessThan(0.002);
      expect(level(out, 1.05, 1.45)).toBeGreaterThan(0.02);
    }
  }, 120_000);
});
