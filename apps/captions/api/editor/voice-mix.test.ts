import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import { ffmpegCommand } from "../ffmpeg-runtime";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-voice-mix-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-voice-mix-test-secret";
const { cleanVoice, readDraft, saveDraft, saveStep } = await import("./store");
const { emptyTracks } = await import("./timeline");
const { pickOf, shareOf, soundDue, soundStep, stemKey, stemsFor, stemsKey, voiceGroups, VOICE_NOTE, withMix } = await import("./voice-mix");
type EditMeta = import("./store").EditMeta;
type StepContext = import("./engine").StepContext;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FPS = 30;
const ff = (...args: string[]) => execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...args]);
/** The loudest sample of a file's sound, in dB (-91 or lower: silence). */
const peak = (file: string) => {
  const err = spawnSync(ffmpegCommand(), ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  return Number(/max_volume: (-?[\d.]+|-inf) dB/.exec(err)?.[1]?.replace("-inf", "-200") ?? NaN);
};
const { probe } = await import("../library/media/probe");
const seconds = async (file: string) => (await probe(file)).duration;

/** A finished Audio Enhancer session on disk: its levelled original silent, its enhanced voice a tone, so the mix says which it plays. */
function session(id: string) {
  const s = path.join(dir, "enhance", id);
  mkdirSync(s, { recursive: true });
  ff("-f", "lavfi", "-t", "4", "-i", "anullsrc=r=48000:cl=mono", "-c:a", "aac", path.join(s, "source.m4a"));
  ff("-f", "lavfi", "-t", "4", "-i", "sine=f=440:r=48000", "-c:a", "aac", path.join(s, "enhanced.m4a"));
  writeFileSync(path.join(s, "meta.json"), JSON.stringify({ id, name: "Take", owner: "maker", hasVideo: false, duration: 4, bytes: 1, status: "done", engine: "nvidia", chain: ["nvidia"], progress: 1, createdAt: 0, updatedAt: 0 }));
}

/** 2.5 s cut: the take on V1 and its voice on A1 from 0.5 s (a gap of black and silence before it). */
function cut(): Timeline {
  const tracks = emptyTracks();
  tracks.V1.items = [{ src: "rec", in: 15, rec: 15, len: 60, link: "a" }];
  tracks.A1.items = [{ src: "rec", in: 15, rec: 15, len: 60, link: "a" }];
  return { name: "v1", fps: FPS, width: 1080, height: 1920, sources: { rec: { versionId: "rec", name: "Take 1", fps: FPS, tc: 0, dur: 120, w: 1920, h: 1080 } }, tracks, markers: [] };
}
const BUNDLE = { designSystem: "plain", grade: "none", voiceMix: "level", sfxSet: "none" };
const edit = (voice?: EditMeta["voice"]) =>
  ({ id: "6f0c2c7e-1b1a-4c3e-9d4e-0a1b2c3d4e5f", name: "Hook", sources: ["rec"], brief: "", bundle: BUNDLE, createdBy: "maker", workspaceId: "maker", ...(voice ? { voice } : {}) }) as unknown as EditMeta;
const ctx = (e: EditMeta): StepContext => ({ edit: e, variant: "v1", job: { actor: "maker" } as StepContext["job"], signal: new AbortController().signal });

describe("an edit's voice, picked", () => {
  it("is as recorded until an enhancer is picked; a recording's own pick and share only count under the edit's", () => {
    expect(pickOf(undefined, "rec")).toBe("off");
    expect(pickOf({ fx: "off", per: { rec: "nvidia" } }, "rec")).toBe("off");
    expect(pickOf({ fx: "adobespeech", per: { rec: "nvidia" } }, "rec")).toBe("nvidia");
    expect(pickOf({ fx: "adobespeech", per: { rec: "off" } }, "rec")).toBe("off");
    expect(shareOf({ fx: "nvidia", mix: { rec: 0.4 } }, "rec")).toBe(0.4);
    expect(shareOf({ fx: "nvidia" }, "rec")).toBe(1);
    expect(shareOf({ fx: "nvidia", per: { rec: "off" }, mix: { rec: 0.4 } }, "rec")).toBe(0);
  });

  it("is cleaned from a body: an id, picks that are ids, shares in steps of 0.05", () => {
    expect(cleanVoice({ fx: "nvidia", per: { a: "off", b: "Bad!", c: 3 }, mix: { a: 0.42, b: 7, c: "x" } })).toEqual({ fx: "nvidia", per: { a: "off" }, mix: { a: 0.4, b: 1 } });
    expect(cleanVoice({ fx: "../x" })).toBeUndefined();
    expect(cleanVoice("nvidia")).toBeUndefined();
    expect(cleanVoice({ fx: "off" })).toEqual({ fx: "off" });
  });

  it("plays the recordings of the voice track (none when it is muted, never a card), and its parts change with the sound or the voice", () => {
    const tl = cut();
    tl.tracks.A1.items.push({ src: "rec2", in: 0, rec: 80, len: 10 }, { src: "rec", in: 0, rec: 95, len: 5, enabled: false });
    expect(voiceGroups(tl)).toEqual(["rec", "rec2"]);
    expect(voiceGroups({ ...tl, tracks: { ...tl.tracks, A1: { ...tl.tracks.A1, mute: true } } })).toEqual([]);
    expect(stemKey("rec")).toMatch(/^[0-9a-f]{8}$/);
    const k = stemsKey(tl, { fx: "nvidia" });
    expect(stemsKey(tl, { fx: "nvidia", mix: { rec: 0.5 } })).not.toBe(k);
    expect(stemsKey({ ...tl, tracks: { ...tl.tracks, V1: { ...tl.tracks.V1, items: [] } } }, { fx: "nvidia" })).toBe(k); // the picture alone: same parts
  });

  it("sends an edit to the sound step only with a voice picked or made, a bed asked for, or the library's sound effects", () => {
    expect(soundDue({ brief: "" })).toBe(false);
    expect(soundDue({ voice: { fx: "off" } })).toBe(false);
    expect(soundDue({ voice: { fx: "off", per: { a: "nvidia" } } })).toBe(true);
    expect(soundDue({ voice: { fx: "nvidia" }, plan: true })).toBe(true);
    expect(soundDue({ song: "s1" })).toBe(true);
    expect(soundDue({ song: "s1", plan: true })).toBe(false);
  });
});

describe("the sound step: a voice made through the Audio Enhancer, in parts for Review", () => {
  beforeAll(async () => {
    session("sess-test-1");
    await saveDraft(edit().id, "v1", { timeline: cut(), notes: [] }); // makes the edit's folder
    await saveStep(edit().id, "voice", { rec: { nvidia: "sess-test-1" } });
  });

  it("files the parts and plays their mix: the enhanced voice at its share, the recording as it is under Off", async () => {
    const tl = cut();
    const e = edit({ fx: "nvidia" });
    await saveDraft(e.id, "v1", { timeline: tl, notes: [`${VOICE_NOTE}an older line`] });
    await soundStep(ctx(e));
    expect(readDraft(e.id, "v1")!.notes).toEqual([]);
    const got = (await stemsFor(e, "v1", tl))!;
    const key = stemKey("rec");
    expect(got.set).toEqual({ groups: [{ key, label: "Take 1", mix: 1 }], fx: ["nvidia"], voice: "nvidia", duration: 2.5 });
    for (const f of ["rest.m4a", `${key}.original.m4a`, `${key}.nvidia.m4a`, "mix.m4a"]) expect(existsSync(path.join(got.dir, f))).toBe(true);
    expect(await seconds(path.join(got.dir, "mix.m4a"))).toBeCloseTo(2.5, 1);
    expect(peak(path.join(got.dir, `${key}.nvidia.m4a`))).toBeGreaterThan(-30);
    expect(peak(path.join(got.dir, "mix.m4a"))).toBeGreaterThan(-30);
    // another voice: these parts are no longer this cut's
    expect(await stemsFor(edit({ fx: "nvidia", mix: { rec: 0.5 } }), "v1", tl)).toBeNull();

    // Off: the parts stay (Review can still offer NVIDIA), and the cut plays the recording as it is
    const off = edit({ fx: "off" });
    await soundStep(ctx(off));
    const o = (await stemsFor(off, "v1", tl))!;
    expect(o.set.voice).toBe("off");
    expect(o.set.fx).toEqual(["nvidia"]);
    expect(peak(path.join(o.dir, "mix.m4a"))).toBeLessThan(-80);
  });

  it("swaps a rendered preview's sound for the mix, the picture copied as it is", async () => {
    const e = edit({ fx: "nvidia" });
    await soundStep(ctx(e));
    const got = (await stemsFor(e, "v1", cut()))!;
    const video = path.join(dir, "preview.mp4");
    ff("-f", "lavfi", "-t", "2.5", "-i", "color=c=black:s=64x64:r=30", "-f", "lavfi", "-t", "2.5", "-i", "anullsrc=r=48000:cl=stereo", "-c:v", "libx264", "-c:a", "aac", "-shortest", video);
    expect(peak(video)).toBeLessThan(-80);
    await withMix(video, got.dir);
    expect(peak(video)).toBeGreaterThan(-30);
    expect(await seconds(video)).toBeCloseTo(2.5, 1);
  });
});
