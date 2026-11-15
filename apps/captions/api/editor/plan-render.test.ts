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

const { atempo, renderPlanPreview, stretchesOf, stretchFilter } = await import("./plan-render");
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
    expect(graph([])).toBe(`${BASE},format=yuv420p`);
    expect(graph([], { speed: 2 })).toMatch(/^setpts=\(PTS-STARTPTS\)\/2,scale=320:180,/);
  });

  it("draws punch, zoom and shake as one scale over time and a crop, in the shot's own time", () => {
    expect(graph([{ type: "punch", at: 0.5, amount: 1.4 }])).toBe(
      `${BASE},scale=w='trunc(320*(if(between(t+0,0.5,0.8),1.4-0.4*((t+0)-0.5)/0.3,1))/2)*2':h='trunc(180*(if(between(t+0,0.5,0.8),1.4-0.4*((t+0)-0.5)/0.3,1))/2)*2':eval=frame,crop=320:180:x='(iw-ow)/2':y='(ih-oh)/2',format=yuv420p`,
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
});
