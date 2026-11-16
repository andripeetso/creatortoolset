import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FootageIndex, IndexSource } from "../../contracts/edit-plan";
import type { Timeline } from "../../contracts/editor";
import { ffmpegCommand } from "../ffmpeg-runtime";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-junk-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-junk-test-secret";

const { focusOf, frameJunk, hudOf, isJunk, junkOf, looks, readPicture, shotsOf } = await import("./index");
const { junkAt, placeShots, repairPlan, shotPool } = await import("./plan");
const { shotFilter } = await import("./preview");

/**
 * Never a shot of nothing (a world map or a dark crop of a game's skill buttons in a cut is noise): dark, flat, still and screen-of-menus stretches never become shots, and a crop follows what moves,
 * off the HUD. Clips are drawn here, frame by frame, as grey video.
 */
const W = 320;
const H = 144;
const N = 250; // 10 s at 25 fps
const at = (f: string) => path.join(dir, f);
const signal = new AbortController().signal;

function video(file: string, frame: (i: number, px: Uint8Array) => void) {
  const buf = Buffer.alloc(W * H * N);
  for (let i = 0; i < N; i++) frame(i, buf.subarray(i * W * H, (i + 1) * W * H));
  execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", "25", "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", file], { input: buf });
}

const land = (x: number, y: number) => 110 + 12 * Math.sin(x / 23) + 10 * Math.sin(y / 17 + x / 41) + 14 * Math.sin(x / 3.1) * Math.sin(y / 2.7);
/** a camera over scrolling land, a hero fighting on the left for 5 s and then on the right, the game's skill buttons
 * still in the bottom-right corner; `panel`: the lower part of the frame a still panel of buttons too */
const world = (panel = false, dim = 1) => (i: number, px: Uint8Array) => {
  const hero = (i < N / 2 ? 80 : 210) + Math.round(12 * Math.sin(i / 2));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let v = land(x + i / 4, y);
      // the hero and the sparks of the fight: stripes that never sit still
      if (x >= hero && x < hero + 30 && y >= 40 && y < 100) v = ((y + x + 5 * i) >> 2) % 2 ? 250 : 5;
      if ((x >= 280 && y >= 112) || (panel && y >= 55)) v = Math.floor((x + y) / 3) % 2 ? 250 : 10;
      px[y * W + x] = Math.max(0, Math.min(255, Math.round(v * dim)));
    }
};

const sources: Record<string, IndexSource> = {};
async function index(name: string) {
  const read = await readPicture(at(`${name}.mp4`), 25, signal);
  const src: IndexSource = { id: name, title: name, dur: N / 25, fps: 25, w: W, h: H, speech: false, shots: shotsOf(read, N / 25), hud: hudOf(read) };
  sources[name] = src;
  return src;
}

beforeAll(async () => {
  video(at("world.mp4"), world());
  video(at("dark.mp4"), world(false, 0.1));
  video(at("hud.mp4"), world(true));
  // a map: parchment with roads and names on it, held still
  video(at("map.mp4"), (_i, px) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = (y % 12 === 3 && x % 40 < 28) || Math.abs(y - x / 3 - 20) < 1 ? 60 : Math.round(190 + 6 * Math.sin(x / 9) * Math.sin(y / 7));
  });
  for (const k of ["world", "dark", "hud", "map"]) await index(k);
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("junk never becomes a shot", () => {
  it("reads a dark clip as dark, a still map as no action, the hero's world as a picture", async () => {
    expect(sources.dark!.shots.every((x) => x.junk === "dark")).toBe(true);
    expect(sources.map!.shots.every((x) => x.junk === "still" || x.junk === "ui")).toBe(true);
    expect(sources.world!.shots.some((x) => x.junk)).toBe(false);
    expect(shotPool(sources.dark!, 8)).toEqual([]);
    expect(shotPool(sources.map!, 8)).toEqual([]);
    expect(shotPool(sources.world!, 8).length).toBeGreaterThan(0);
    expect(await frameJunk(at("dark.mp4"), 5, sources.dark!, [9, 16], { x: 0.5, y: 0.5 })).toBe("dark");
    expect(await frameJunk(at("world.mp4"), 5, sources.world!, [9, 16], { x: 0.5, y: 0.5 })).toBe("");
  });

  it("reads a page of flat panels as a screen of menus, and the AI's junk mark as junk", () => {
    const page = new Float32Array(64 * 36).fill(60);
    for (let x = 4; x < 40; x++) page[4 * 64 + x] = 200;
    for (let y = 20; y < 36; y++) for (let x = 30; x < 64; x++) page[y * 64 + x] = (x * 37 + y * 91) % 255;
    expect(junkOf(looks(page, 64, 36, new Float32Array(64 * 36).fill(10)))).toBe("ui"); // grey-navy panels
    expect(junkOf(looks(page, 64, 36, new Float32Array(64 * 36).fill(80)))).toBe(""); // a cartoon's flat colours
    expect(isJunk({ desc: "junk: map of the world" })).toBe(true);
    expect(isJunk({ desc: "a knight fights two skeletons" })).toBe(false);
  });

  it("moves a planned shot off a junk stretch to action", () => {
    const idx: FootageIndex = { sources: [sources.map!, sources.world!] };
    const { plan, notes } = repairPlan({ kind: "hard edit", lead: "sources", shots: [{ at: 0, dur: 1.5, src: { source: "S1", inS: 3 } }] }, { index: idx, targetS: 0, size: { w: 1080, h: 1920, fps: 25 }, fixedSize: true, gen: [], brief: "" });
    expect(junkAt(sources.map!, 3, 1.5)).toBe(true);
    expect(plan.shots[0]!.src).toMatchObject({ source: "world" });
    expect(notes.join(" ")).toMatch(/map, a menu, a loading screen or a dark stretch/);
  });
});

describe("the crop follows the action, off the HUD", () => {
  it("tracks the hero across a wide picture", () => {
    const early = focusOf(sources.world!, 1, 4, 9, 16);
    const late = focusOf(sources.world!, 6.5, 9.5, 9, 16);
    expect(early.x).toBeLessThan(0.4);
    expect(late.x).toBeGreaterThan(0.6);
    expect(early.ok && late.ok).toBe(true);
    // at the very edge of a picture this wide (a phone's skill buttons sit there), no window fills the frame
    const edge = { w: W, h: H, hud: [], shots: [{ a: 0, b: 10, motion: 1, moves: { cols: [...Array(15).fill(0), 1], rows: Array(9).fill(1 / 9) } }] };
    expect(focusOf(edge, 2, 6, 9, 16).ok).toBe(false);
  });

  it("finds the still skill buttons and never fills the frame with a window that is mostly HUD", () => {
    const hud = sources.world!.hud!;
    expect(hud[7 * 16 + 14] && hud[7 * 16 + 15] && hud[8 * 16 + 14] && hud[8 * 16 + 15]).toBe(1);
    expect(hud.slice(3 * 16, 6 * 16).filter(Boolean).length / 48).toBeLessThan(0.25);
    expect(focusOf(sources.hud!, 3, 5, 9, 16).ok).toBe(false);
    const shots = [{ at: 0, dur: 1.5, src: { source: "hud", inS: 3 } }, { at: 1.5, dur: 1.5, src: { source: "world", inS: 1.5 } }];
    placeShots(shots, { sources: [sources.hud!, sources.world!] }, 1080, 1920);
    expect(shots[0]).toMatchObject({ frame: "blur" });
    expect(shots[1]!).not.toHaveProperty("frame");
    expect((shots[1] as { focus?: { x: number } }).focus!.x).toBeLessThan(0.4);
  });

  it("draws the crop where the plan put it, and as before without one", () => {
    const tl = { name: "t", fps: 25, width: 1080, height: 1920, sources: { s: { versionId: "s", name: "s", fps: 25, tc: 0, dur: 250, w: 2348, h: 1080 } } } as unknown as Timeline;
    const item = { src: "s", in: 0, len: 25, rec: 0, zoom: 1920 / (1080 * (1080 / 2348)) };
    const plain = shotFilter(tl, item);
    expect(shotFilter(tl, { ...item, focus: { x: 0.5, y: 0.5 } })).toBe(plain);
    const right = shotFilter(tl, { ...item, focus: { x: 0.9, y: 0.5 } }).match(/crop=\d+:\d+:(\d+):/)![1]!;
    const middle = plain.match(/crop=\d+:\d+:(\d+):/)![1]!;
    expect(Number(right)).toBeGreaterThan(Number(middle));
  });
});
