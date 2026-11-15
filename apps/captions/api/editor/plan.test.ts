import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FootageIndex, SongBeats } from "../../contracts/edit-plan";

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(m.aiFor), completeWithFallback: vi.fn(m.completeWithFallback) };
});
// the AI looking at contact sheets (index.ts): it sees a test pattern
vi.mock("../ai-vision", async (real) => ({
  ...(await real<typeof import("../ai-vision")>()),
  completeVisionWithFallback: vi.fn(async (_s: string, _u: string, _i: unknown, _sig: unknown, parse: (t: string) => unknown) => ({ value: parse('{"shots":{"1":"a moving test pattern"},"story":"A test pattern moves."}') })),
}));

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-plan-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-plan-test-secret";
delete process.env.ANTHROPIC_API_KEY;

const { aiFor, completeWithFallback } = await import("../ai-complete");
const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { blobs, libraryDb } = await import("../library/db");
const { saveTranscript } = await import("../library/transcribe");
const { enqueueJob } = await import("../library/jobs");
const { readMeta } = await import("../review");
const { NO_SPEECH } = await import("./analyze");
const { APART_S, briefMaxS, isPlanned, lengthOf, MIN_SHOT_S, openerOf, parsePlans, planPrompt, planTimeline, repairPlan, shotPool, snapCuts, sourceSpan, speechShare, UNDER_DB } = await import("./plan");
const { toOtio } = await import("./otio");
const { toFcpxml } = await import("./fcpxml");
const { qaOf } = await import("./qa");
const { createEdit, readDraft, readEdit, readStep } = await import("./store");
const { tick } = await import("./worker");
const { songBeats } = await import("./index");

/** Two sources with a picture (one without sound), a song with no picture, beats at 120 bpm from 0. */
const index = (): FootageIndex => ({
  sources: [
    { id: "ver_game", title: "Tiny Acrobatics run", dur: 20, fps: 30, w: 1920, h: 1080, speech: false, sound: true, shots: [{ a: 0, b: 20, motion: 0.8 }] },
    { id: "ver_mute", title: "Tiny Acrobatics silent", dur: 4, fps: 30, w: 1080, h: 1920, speech: false, sound: false, shots: [{ a: 0, b: 4, motion: 0.2 }] },
    { id: "ver_song", title: "Song", dur: 60, fps: 30, w: 0, h: 0, speech: false, sound: true, shots: [{ a: 0, b: 60, motion: 0 }] },
  ],
  song: beatsAt(120, 0, 60),
});
function beatsAt(bpm: number, startS: number, dur: number): SongBeats {
  const beats: number[] = [];
  for (let t = startS; t < dur; t += 60 / bpm) beats.push(t);
  return { source: "ver_song", startS, bpm, beats, downbeats: beats.filter((_, k) => k % 4 === 0), strong: beats.filter((_, k) => k % 4 === 0), sections: [{ a: startS, b: dur, energy: 0.5 }] };
}
const ctx = (over: Partial<Parameters<typeof repairPlan>[1]> = {}) => ({ index: index(), song: { id: "ver_song", dur: 60 }, targetS: 0, size: { w: 1080, h: 1920, fps: 30 }, fixedSize: false, gen: [], ...over });

describe("the plan: checked and repaired, never trusted", () => {
  it("keeps shots from sources that exist and have a picture, laid end to end from 0 with no gap or overlap", () => {
    const { plan, notes } = repairPlan(
      {
        kind: "hard edit",
        lead: "song",
        shots: [
          { src: "S1", in: 3, dur: 1.1, at: 5 },
          { src: "nope", in: 0, dur: 1 },
          { src: "S3", in: 0, dur: 1 },
          { src: "ver_game", in: 30, dur: 0.9, at: 1 },
          { src: { source: "ver_mute", inS: 1 }, dur: 1, sound: "full" },
        ],
      },
      ctx(),
    );
    expect(notes).toContain("The AI planned a shot from “nope”, which is not one of the sources: left out");
    expect(notes).toContain("The AI planned a shot from S3, which has no picture: left out");
    // in the AI's order of `at` (none counts as 0), closed up, and each cut on a beat (every 0.5 s)
    expect(plan.shots.map((s) => [s.src, s.at, s.dur])).toEqual([
      [{ source: "ver_mute", inS: 1 }, 0, 1],
      // an in-point past the source's end is pulled back so the shot fits
      [{ source: "ver_game", inS: 18.999 }, 1, 1],
      [{ source: "ver_game", inS: 3 }, 2, 1],
    ]);
    // a source with no sound never plays it
    expect(plan.shots[0]!.sound).toBe("off");
    expect(plan.lead).toEqual({ type: "song", source: "ver_song", startS: 0 });
  });

  it("holds the length the brief asks for and never runs past the song", () => {
    const shots = Array.from({ length: 30 }, () => ({ src: "S1", in: 0, dur: 1 }));
    expect(repairPlan({ shots }, ctx({ targetS: 12 })).plan.shots.reduce((n, s) => n + s.dur, 0)).toBeCloseTo(12, 5);
    const short = repairPlan({ shots }, ctx({ targetS: 25, song: { id: "ver_song", dur: 9.6 } }));
    expect(short.plan.shots.reduce((n, s) => n + s.dur, 0)).toBeCloseTo(9.5, 5);
    expect(short.notes).toContain("It is 9.5 s, 25 s were asked for: the song ends there");
    // without the song (the AI keeps the footage's sound), the plan's own length
    const own = repairPlan({ lead: "sources", shots: shots.slice(0, 4) }, ctx());
    expect(own.plan.lead).toEqual({ type: "sources" });
    expect(own.plan.shots.reduce((n, s) => n + s.dur, 0)).toBeCloseTo(4, 5);
  });

  it("puts cuts on beats in whole frames, counted from the song's start, at a tempo that misses frame boundaries", () => {
    const song = beatsAt(128, 2.3, 60);
    const fps = 30000 / 1001;
    const { plan } = repairPlan({ shots: [1.1, 0.4, 0.95, 2.2].map((dur) => ({ src: "S1", in: 0, dur })) }, ctx({ index: { ...index(), song }, size: { w: 1080, h: 1920, fps } }));
    const edges = plan.shots.map((s) => Math.round(s.at * fps));
    const beatFrames = song.beats.map((b) => Math.round((b - 2.3) * fps));
    for (const f of edges.slice(1)) expect(beatFrames).toContain(f);
    // each shot is a whole number of frames, and they add up to the end with no frame lost
    for (const s of plan.shots) expect(Math.abs(s.dur * fps - Math.round(s.dur * fps))).toBeLessThan(0.02);
    expect(plan.lead).toMatchObject({ startS: 2.3 });
    expect(snapCuts([0.3, 0.31, 0.9], 1.5, [0.25, 0.5, 1, 1.25])).toEqual([0.25, 0.5, 1]);
    // no beat between its neighbours: kept where it was, a shot never under MIN_SHOT_S
    expect(snapCuts([0.6], 1.2, [])).toEqual([0.6]);
    expect(snapCuts([0.05, 1.19], 1.2, []).map((x) => +x.toFixed(6))).toEqual([MIN_SHOT_S, 1]);
  });

  it("clamps speeds, ramps and effects into their ranges and their shots, and drops what it does not know", () => {
    const { plan } = repairPlan(
      {
        lead: "sources",
        shots: [
          {
            src: "S1",
            in: 0,
            dur: 2,
            speed: 99,
            fx: [{ type: "punch", at: -3, amount: 9 }, { type: "explode" }, { type: "zoom", at: 1, dur: 9, from: 0, to: 7 }, { type: "flash", at: 5, color: "red" }, { type: "glitch", amount: 3 }],
          },
          { src: "S1", in: 0, dur: 1, ramp: [{ t: 0, speed: 1 }, { t: 0.5, speed: 0.01 }, { t: 9, speed: 2 }] },
        ],
      },
      ctx({ song: undefined, index: { ...index(), song: undefined } }),
    );
    const [a, b] = plan.shots;
    expect(a!.speed).toBe(4);
    expect(a!.fx).toEqual([
      { type: "punch", at: 0, amount: 2 },
      { type: "zoom", at: 1, dur: 1, from: 1, to: 3 },
      { type: "flash", at: 1.96, dur: 0.04 },
      { type: "glitch", at: 0, dur: 0.3, amount: 1 },
    ]);
    // a ramp's points inside the shot and its speeds in range; the source it plays is its speed over its time
    expect(b!.ramp).toEqual([{ t: 0, speed: 1 }, { t: 0.5, speed: 0.25 }, { t: 1, speed: 2 }]);
    expect(sourceSpan(1, 1, b!.ramp)).toBeCloseTo(0.5 * 0.625 + 0.5 * 1.125, 5);
    // a 4x shot of 2 s plays 8 s of source: the in-point leaves room for it
    expect((a!.src as { inS: number }).inS).toBeLessThanOrEqual(20 - 8);
  });

  it("slows a shot down to fit a source shorter than it, and makes an edit from the footage when the AI gave nothing usable", () => {
    const slowed = repairPlan({ lead: "sources", shots: [{ src: "S2", in: 0, dur: 6 }] }, ctx({ song: undefined }));
    expect(slowed.plan.shots[0]!.speed).toBeCloseTo(0.666, 2);
    expect(slowed.notes).toContain("1 shot was slowed down to fit its source");
    const none = repairPlan({ shots: [{ src: "S9", dur: 1 }] }, ctx({ targetS: 6 }));
    expect(none.notes).toContain("The AI's plan had no shot that can be used: the footage is cut in turn instead");
    expect(none.plan.shots.length).toBe(6);
    expect(none.plan.shots.every((s) => "source" in s.src)).toBe(true);
  });

  it("takes the AI's frame unless the edit has its own, and reads a bare plan as well as a list", () => {
    expect(repairPlan({ w: 1921, h: 1080, shots: [{ src: "S1", dur: 1 }] }, ctx()).plan).toMatchObject({ w: 1922, h: 1080 });
    expect(repairPlan({ w: 1920, h: 1080, shots: [{ src: "S1", dur: 1 }] }, ctx({ fixedSize: true })).plan).toMatchObject({ w: 1080, h: 1920 });
    expect(parsePlans('```json\n{"kind":"recap","shots":[{"src":"S1","dur":2}]}\n```')).toHaveLength(1);
    expect(() => parsePlans('{"plans":[{"shots":[]}]}')).toThrow("The AI's answer has no shots");
  });

  it("asks with the brief, the setup, every source by tag and the song's beats in the edit's time", () => {
    const { system, user } = planPrompt({ brief: "An overdone hard edit", versions: 1, targetS: 25, setup: "Workspace: Tiny Acrobatics", index: { ...index(), song: beatsAt(120, 1, 60) }, words: {}, song: { id: "ver_song", key: "k", title: "Song", dur: 60, from: "" }, gen: [] });
    expect(system).toMatch(/Make exactly the kind of edit the brief asks for/);
    expect(user).toContain("Brief:\nAn overdone hard edit");
    expect(user).toContain("The workspace's setup:\nWorkspace: Tiny Acrobatics");
    expect(user).toContain('S1 "Tiny Acrobatics run": 20.0 s, 1920x1080 at 30 fps, sound');
    expect(user).toContain('S2 "Tiny Acrobatics silent": 4.0 s, 1080x1920 at 30 fps, no sound');
    expect(user).toContain("Beats (seconds in the edit): 0.00 0.50 1.00");
    expect(speechShare([{ s: 0, e: 2 }, { s: 5, e: 6 }], 30)).toBeCloseTo(0.1, 5);
  });

  it("lays a plan as the draft: shots filling the frame on V1 with their speed and effects, their own sound where asked, the song on A2", () => {
    const { plan } = repairPlan(
      { kind: "hard edit", texts: [{ at: 0.5, dur: 1, text: "GO", place: "top" }], shots: [{ src: "S1", in: 2, dur: 1, speed: 2, fx: [{ type: "shake", at: 0 }], sound: "under" }, { src: "S2", in: 0, dur: 1 }] },
      ctx(),
    );
    const src = (id: string, w: number, h: number) => ({ versionId: id, name: id, fps: 30, tc: 0, dur: 1800, w, h });
    const tl = planTimeline(plan, { ver_game: src("ver_game", 1920, 1080), ver_mute: src("ver_mute", 1080, 1920), ver_song: src("ver_song", 0, 0) }, "Run v1");
    expect(tl.plan).toEqual({ kind: "hard edit", texts: [{ at: 0.5, dur: 1, text: "GO", place: "top" }] });
    expect(tl.tracks.V1.items).toEqual([
      { src: "ver_game", in: 60, len: 30, rec: 0, link: "c1", zoom: 3.16, speed: 2, fx: [{ type: "shake", at: 0, dur: 0.3, amount: 0.5 }] },
      { src: "ver_mute", in: 0, len: 30, rec: 30, link: "c2" },
    ]);
    expect(tl.tracks.A1.items).toEqual([{ src: "ver_game", in: 60, len: 30, rec: 0, link: "c1", gainDb: UNDER_DB, speed: 2 }]);
    expect(tl.tracks.A2.items).toEqual([{ src: "ver_song", in: 0, len: 60, rec: 0 }]);
    expect(tl.markers.map((m) => [m.rec, m.name, m.note])).toEqual([
      [0, "Shot 1", "speed 2 · shake at 0.00 s"],
      [15, "Text", "GO"],
      [30, "Shot 2", ""],
    ]);
    // the checks don't hold a planned cut to the speaker's rules: no voice gap, no shortest shot
    expect(qaOf(tl).notes).toEqual([]);
    // the exports carry the cut, the speed and a marker per shot (the effects are in its note)
    const files = { ver_game: "/media/run.mp4", ver_mute: "/media/silent.mp4", ver_song: "/media/song.wav" };
    const otio = JSON.stringify(toOtio(tl, files));
    expect(otio).toContain('"OTIO_SCHEMA":"LinearTimeWarp.1","name":"","effect_name":"LinearTimeWarp","metadata":{},"time_scalar":2');
    expect(otio).toContain('"name":"Shot 1"');
    const xml = toFcpxml(tl, files);
    expect(xml).toContain('<timept time="1s" value="2s" interp="linear"/>');
    expect(xml).toContain('value="Shot 1" note="speed 2 · shake at 0.00 s"');
  });

  it("plays a generated clip as it was made: no speed, no ramp", () => {
    const { plan } = repairPlan({ shots: [{ generate: { style: "plasma" }, dur: 1, speed: 2, ramp: [{ t: 0, speed: 1 }, { t: 1, speed: 3 }] }] }, ctx({ gen: ["plasma"] }));
    expect(plan.shots[0]).toMatchObject({ src: { generate: { style: "plasma", seconds: 1 } }, dur: 1 });
    expect(plan.shots[0]!.speed).toBeUndefined();
    expect(plan.shots[0]!.ramp).toBeUndefined();
  });
});

/** Eight long sources (3 min, a shot every 2 s, motion that rises and falls), a song at 160 bpm from 0. */
const TITLES = ["Canyon run", "Night city", "Forest chase", "Season zero defense", "Harbor fight", "Desert boss", "Ice cave", "Sky bridge"];
const longIndex = (): FootageIndex => ({
  sources: TITLES.map((title, k) => ({
    id: `ver_${k + 1}`,
    title: `${title}.mp4`,
    dur: 180,
    fps: 30,
    w: 1920,
    h: 1080,
    speech: false,
    sound: true,
    shots: Array.from({ length: 90 }, (_, j) => ({ a: j * 2, b: j * 2 + 2, motion: Math.round(Math.abs(Math.sin(j * 0.7 + k)) * 100) / 100, ...(k === 3 && j === 61 ? { desc: "the screen says HEALED and the buffs glow" } : {}) })),
  })),
  song: { ...beatsAt(160, 0, 120), strong: beatsAt(160, 0, 120).beats.filter((_, j) => j % 2 === 0) },
});
const longCtx = (over: Partial<Parameters<typeof repairPlan>[1]> = {}) => ({ ...ctx(), index: longIndex(), song: { id: "ver_song", dur: 120 }, ...over });
/** Every pair of shown stretches of one source keeps APART_S: no moment twice. */
function noRepeats(shots: ReturnType<typeof repairPlan>["plan"]["shots"]) {
  const spans = shots.flatMap((s) => {
    const span = sourceSpan(s.dur, s.speed, s.ramp);
    return ["source" in s.src ? s.src : null, ...(s.split ?? [])].filter((x): x is { source: string; inS: number } => !!x).map((x) => [x.source, x.inS, x.inS + span] as const);
  });
  for (const [i, a] of spans.entries()) for (const b of spans.slice(i + 1)) if (a[0] === b[0]) expect(a[2] <= b[1] - APART_S + 1e-3 || b[2] <= a[1] - APART_S + 1e-3, `${a} and ${b}`).toBe(true);
}

describe("an edit as the brief asks: its length, no moment twice, its opener, its effects, its sizes", () => {
  it("reads a length limit from the brief, and keeps a hard or social edit to 15-25 s with none", () => {
    expect(briefMaxS("an overdone hard edit, max 25 s")).toBe(25);
    expect(briefMaxS("This should be maximum 25 seconds")).toBe(25);
    expect(briefMaxS("no longer than 1 minute please")).toBe(60);
    expect(briefMaxS("a 20-second reel")).toBe(20);
    expect(briefMaxS("cut the 25 best moments")).toBe(0);
    expect(lengthOf("a hard edit", 0)).toEqual({ max: 25, min: 15, about: false });
    expect(lengthOf("a calm recap", 0).max).toBe(0);
    // target_s never past what the brief allows
    expect(lengthOf("max 25 s", 30).max).toBe(25);
  });

  it("cuts a 40 s plan to 25 s on a downbeat, and never reuses a moment the AI repeated", () => {
    const shots = Array.from({ length: 40 }, (_, k) => ({ src: `S${(k % 3) + 1}`, in: 30, dur: 1 }));
    const { plan, notes } = repairPlan({ shots }, longCtx({ brief: "an overdone hard edit" }));
    const len = plan.shots.reduce((n, s) => n + s.dur, 0);
    expect(len).toBeLessThanOrEqual(25 + 1e-9);
    expect(len).toBeGreaterThanOrEqual(15);
    // 160 bpm: a bar is 1.5 s, so the end is a multiple of it
    expect(Math.abs(len / 1.5 - Math.round(len / 1.5))).toBeLessThan(0.03);
    noRepeats(plan.shots);
    expect(notes.some((n) => n.includes("already in the edit"))).toBe(true);
    // the brief's own limit wins over target_s
    expect(repairPlan({ shots }, longCtx({ brief: "max 20 s", targetS: 30 })).plan.shots.reduce((n, s) => n + s.dur, 0)).toBeLessThanOrEqual(20 + 1e-9);
  });

  it("moves a repeat to footage not shown yet, in another source when its own is used up", () => {
    const shots = [...Array.from({ length: 6 }, () => ({ src: "S2", in: 1, dur: 1.5 }))];
    const tiny = longIndex();
    tiny.sources[1]!.dur = 5;
    const { plan } = repairPlan({ lead: "sources", shots }, longCtx({ index: tiny, song: undefined }));
    noRepeats(plan.shots);
    expect(plan.shots.length).toBe(6);
    expect(new Set(plan.shots.map((s) => ("source" in s.src ? s.src.source : ""))).size).toBeGreaterThan(1);
  });

  it("opens on what the brief names: a source by tag or title, at the moment its words describe", () => {
    const idx = longIndex();
    expect(openerOf("start with S3", idx)?.source.id).toBe("ver_3");
    const named = openerOf("start with this season zero defense footage when it says healed and show the buffs", idx);
    expect(named?.source.id).toBe("ver_4");
    expect(named?.shot?.a).toBe(122);
    expect(openerOf("a hard edit", idx)).toBeNull();
    const shots = Array.from({ length: 12 }, (_, k) => ({ src: `S${(k % 8) + 1}`, in: 10 + k * 5, dur: 1.5 }));
    const { plan, notes } = repairPlan({ shots }, longCtx({ brief: "a hard edit, start with the season zero defense footage when it says healed" }));
    expect(plan.shots[0]!.src).toEqual({ source: "ver_4", inS: 122 });
    expect(notes).toContain("The edit opens on S4 at 122.0 s, as the brief asks");
    // the prompt says it too
    expect(planPrompt({ brief: "start with S3", versions: 1, targetS: 0, setup: "", index: idx, words: {}, gen: [] }).user).toContain("Open with: S3");
  });

  it("gives an overdone edit an effect on every shot, stacks on the strong beats, and three sizes or more", () => {
    const shots = Array.from({ length: 16 }, (_, k) => ({ src: `S${(k % 8) + 1}`, in: 20 + k * 7, dur: 1.5 }));
    const { plan } = repairPlan({ shots }, longCtx({ brief: "an overdone hard edit" }));
    expect(plan.shots.every((s) => (s.fx?.length ?? 0) >= 1)).toBe(true);
    // every shot starts on a beat here and every other beat is strong: some carry a stack of three
    expect(plan.shots.some((s) => (s.fx?.length ?? 0) >= 3)).toBe(true);
    expect(new Set(plan.shots.map((s) => (s.split ? "split" : (s.frame ?? "fill")))).size).toBeGreaterThanOrEqual(3);
    // a calm brief is left as the AI wrote it
    const calm = repairPlan({ shots }, longCtx({ brief: "a calm recap" })).plan;
    expect(calm.shots.every((s) => !s.fx?.length && !s.frame)).toBe(true);
  });

  it("cleans the new effects and the frame fields: an inset never first, a split from sources that exist", () => {
    const { plan } = repairPlan(
      {
        lead: "sources",
        shots: [
          { src: "S1", in: 0, dur: 2, frame: "inset", scale: 5, fx: [{ type: "stutter", at: 0.5, dur: 9, amount: 40 }, { type: "reverse" }, { type: "reverse" }] },
          { src: "S2", in: 0, dur: 2, frame: "inset", scale: 0.1, fx: [{ type: "freeze", at: 1, dur: 0.01 }, { type: "zoomblur", amount: 7 }] },
          { src: "S3", in: 0, dur: 2, frame: "letterbox", split: [{ src: "S4", in: 10 }, { src: "nope", in: 0 }, { src: "S5", in: 0 }] },
          { src: "S4", in: 0, dur: 2, frame: "wobbly", ramp: [{ t: 0, speed: 1 }, { t: 1, speed: 2 }], fx: [{ type: "reverse" }] },
        ],
      },
      longCtx({ song: undefined, index: { ...longIndex(), song: undefined } }),
    );
    const [a, b, c, d] = plan.shots;
    expect(a!.frame).toBeUndefined();
    expect(a!.fx).toEqual([{ type: "stutter", at: 0.5, dur: 0.188, amount: 8 }, { type: "reverse" }]);
    expect(b).toMatchObject({ frame: "inset", scale: 0.3, fx: [{ type: "freeze", at: 1, dur: 0.1 }, { type: "zoomblur", at: 0, dur: 0.25, amount: 1 }] });
    // a split takes the column: no frame of its own, and only the sources that exist
    expect(c!.frame).toBeUndefined();
    expect(c!.split?.map((p) => p.source)).toEqual(["ver_4"]);
    // a reversed shot plays at one speed; a frame it doesn't know is fill
    expect(d!.ramp).toBeUndefined();
    expect(d!.frame).toBeUndefined();
    noRepeats(plan.shots);
  });

  it("lays the sizes as the timeline's zoom (what an export carries) and the split's sources beside it", () => {
    const plan = {
      kind: "hard edit", w: 1080, h: 1920, fps: 30, lead: { type: "sources" as const },
      shots: [
        { at: 0, dur: 1, src: { source: "ver_1", inS: 0 } },
        { at: 1, dur: 1, src: { source: "ver_2", inS: 0 }, frame: "fit" as const },
        { at: 2, dur: 1, src: { source: "ver_3", inS: 0 }, frame: "inset" as const, scale: 0.5 },
        { at: 3, dur: 1, src: { source: "ver_4", inS: 0 }, frame: "letterbox" as const },
        { at: 4, dur: 1, src: { source: "ver_5", inS: 0 }, split: [{ source: "ver_6", inS: 2 }] },
      ],
    };
    const src = (id: string) => ({ versionId: id, name: id, fps: 30, tc: 0, dur: 5400, w: 1920, h: 1080 });
    const tl = planTimeline(plan, Object.fromEntries(["ver_1", "ver_2", "ver_3", "ver_4", "ver_5", "ver_6"].map((id) => [id, src(id)])), "Hard edit v1");
    const [fill, fit, inset, lb, split] = tl.tracks.V1.items;
    // wide footage in a tall frame: fitted 1080x607.5, covering takes 1920/607.5
    expect(fill!.zoom).toBeCloseTo(3.16, 2);
    expect(fit!.zoom).toBeUndefined();
    expect(fit!.frame).toBe("fit");
    expect(inset!.zoom).toBe(0.5);
    // a 2.39:1 band across 1080 is 452 high: less than the fitted picture, so no zoom
    expect(lb!.zoom).toBeUndefined();
    expect(split!.split).toEqual([{ src: "ver_6", in: 60 }]);
    expect(tl.sources.ver_6).toBeDefined();
    expect(tl.markers.find((m) => m.name === "Shot 3")?.note).toContain("inset at 50 % of the width");
  });

  it("hands the AI each source's strongest moments spread over its whole length, not its first minutes", () => {
    const s = longIndex().sources[0]!;
    const pool = shotPool(s, 15);
    expect(pool.length).toBe(15);
    // spread: some in each third of the source, never two within its gap (4.5 s = 180 / 40)
    for (const third of [0, 60, 120]) expect(pool.some((x) => x.a >= third && x.a < third + 60)).toBe(true);
    for (const [i, x] of pool.entries()) for (const y of pool.slice(i + 1)) expect(Math.abs(x.a - y.a)).toBeGreaterThanOrEqual(4.5);
    const user = planPrompt({ brief: "an overdone hard edit, max 25 s", versions: 1, targetS: 0, setup: "", index: longIndex(), words: {}, gen: [] }).user;
    expect(user).toContain("15 of its 90 shots:");
    expect(user).toContain("Length: at most 25 seconds");
    expect(user).toContain("Effects: overdone.");
    // the moment the brief's words describe is always in the pool
    expect(planPrompt({ brief: "when it says healed", versions: 1, targetS: 0, setup: "", index: longIndex(), words: {}, gen: [] }).user).toContain("122.0-124.0 motion");
  });
});

describe("footage where nobody speaks reaches Review", () => {
  const ff = (...args: string[]) => execFileSync(ffmpegCommand(), ["-v", "error", "-y", ...args]);
  beforeAll(async () => {
    const game = path.join(dir, "game.mp4");
    const song = path.join(dir, "song.wav");
    ff("-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=8", "-f", "lavfi", "-i", "anoisesrc=d=8:a=0.05", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", game);
    // a click on every beat at 120 bpm
    ff("-f", "lavfi", "-i", "aevalsrc='0.8*sin(2*PI*880*t)*lt(mod(t,0.5),0.04)':s=44100:d=10", song);
    const d = libraryDb();
    d.exec(`
      INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'mem-a', 'A', 'local', 0);
      INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_game', 'lib_a', 'video', 'Tiny Acrobatics run', 'mem-a', 0), ('ast_song', 'lib_a', 'audio', 'Tiny Acrobatics theme', 'mem-a', 0);
      INSERT INTO asset_tags (asset_id, tag, source) VALUES ('ast_song', 'music', 'user');
    `);
    const probes = {
      ver_game: { duration: 8, width: 320, height: 180, fps: 30, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" },
      ver_song: { duration: 10, width: 0, height: 0, fps: 0, rotation: 0, format: "wav", vcodec: "", pixFmt: "", acodec: "pcm_s16le" },
    };
    for (const [v, a, f] of [["ver_game", "ast_game", game], ["ver_song", "ast_song", song]] as const) {
      d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'mem-a', 0)").run(v, a, `libraries/lib_a/v/${v}/source`, `sha-${v}`, JSON.stringify(probes[v]));
      d.prepare("UPDATE assets SET current_version_id = ? WHERE id = ?").run(v, a);
      const copy = `${f}.copy`;
      execFileSync("cp", [f, copy]);
      await blobs.put(`libraries/lib_a/v/${v}/source`, copy);
    }
    // its transcript is silence: nobody speaks
    saveTranscript(d, "ver_game", "deepgram", "en", [], []);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("judges speech per source: one take where someone talks keeps a folder of takes and long wordless clips cut around speech", () => {
    const d = libraryDb();
    const p = (s: number) => JSON.stringify({ duration: s, width: 320, height: 180, fps: 30, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" });
    d.exec(`INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_take', 'lib_a', 'video', 'Take', 'mem-a', 0), ('ast_long', 'lib_a', 'video', 'Long clip', 'mem-a', 0)`);
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES ('ver_take', 'ast_take', 1, 'k1', 1, 's1', ?, 'ready', 'mem-a', 0), ('ver_long', 'ast_long', 1, 'k2', 1, 's2', ?, 'ready', 'mem-a', 0)").run(p(30), p(900));
    const said = [{ n: 1, src: "ver_take", text: "hello there", s: 0, e: 20, w0: 0, w1: 1 }];
    const edit = (over: object = {}) => ({ sources: ["ver_take", "ver_long", "ver_game"], ...over }) as unknown as Parameters<typeof isPlanned>[0];
    expect(isPlanned(edit(), said)).toBe(false);
    expect(isPlanned(edit(), [])).toBe(true);
    expect(isPlanned(edit({ plan: true }), said)).toBe(true);
    // a few words made up over a long wordless clip are nobody speaking
    expect(isPlanned(edit({ sources: ["ver_long"] }), [{ ...said[0]!, src: "ver_long", e: 30 }])).toBe(true);
    // everything B-roll as the library sorted it: planned, whatever words it has
    d.exec("UPDATE assets SET roll = 'b' WHERE id IN ('ast_take', 'ast_long')");
    expect(isPlanned(edit({ sources: ["ver_take", "ver_long"] }), said)).toBe(true);
    d.exec("UPDATE assets SET roll = NULL WHERE id IN ('ast_take', 'ast_long')");
  });

  it("is analyzed with no refusal, planned to the song among its sources, drawn and filed in Review", async () => {
    vi.mocked(aiFor).mockReturnValue({ only: ["mac"] });
    let asked = "";
    vi.mocked(completeWithFallback).mockImplementation(async (_s, user, _sig, parse) => {
      asked = user;
      return parse(JSON.stringify({ plans: [{ kind: "hard edit", lead: "song", shots: [{ generate: { style: "plasma", palette: ["#ff0066", "#00ccff"] }, dur: 0.5 }, { src: "S1", in: 0, dur: 1, fx: [{ type: "flash", at: 0 }] }, { src: "S1", in: 3, dur: 1.5, speed: 2, fx: [{ type: "glitch", at: 0.2, dur: 0.3 }] }, { src: "S1", in: 6, dur: 1 }] }] }));
    });
    const e = (await createEdit("mem-a", { sources: ["ver_game", "ver_song"], brief: "A hard edit to the beat", targetS: 3 }))!;
    const d = libraryDb();
    enqueueJob(d, "mem-a", `${e.id}:`, "analyze", "mem-a", true, "edit_jobs");
    let clock = 10 ** 13;
    for (let i = 0; i < 400; i++) {
      if (!d.prepare("SELECT 1 FROM edit_jobs WHERE edit_id = ? AND state IN ('queued', 'running')").get(e.id)) break;
      await tick((clock += 60_000));
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(d.prepare("SELECT kind, variant, state, error FROM (SELECT kind, substr(version_id, 38) AS variant, state, error, id FROM edit_jobs WHERE edit_id = ?) ORDER BY id").all(e.id)).toEqual([
      { kind: "analyze", variant: "", state: "done", error: null },
      { kind: "script", variant: "", state: "done", error: null },
      { kind: "draft", variant: "", state: "done", error: null },
      { kind: "draft", variant: "v1", state: "done", error: null },
      { kind: "broll", variant: "v1", state: "done", error: null },
      { kind: "post", variant: "v1", state: "done", error: null },
      { kind: "preview", variant: "v1", state: "done", error: null },
      { kind: "file", variant: "v1", state: "done", error: null },
    ]);
    // the song is never transcribed; the AI was shown the footage and the song's beats
    expect(d.prepare("SELECT 1 FROM jobs WHERE version_id = 'ver_song' AND kind = 'transcribe'").get()).toBeUndefined();
    expect(readStep(e.id, "analysis")!.notes).toContain(`${NO_SPEECH}. If someone does speak in it, pick the language on the edit and run it again`);
    expect(asked).toContain('S1 "Tiny Acrobatics run"');
    expect(asked).toContain(": a moving test pattern");
    expect(asked).toContain("What happens across the footage, from the pictures:\nA test pattern moves.");
    expect(asked).toContain('Song "Tiny Acrobatics theme" leads');
    expect(readStep(e.id, "plan")!.notes[0]).toBe("Cut to “Tiny Acrobatics theme” (a song among the sources)");
    expect(readEdit(e.id)!.name).toBe("Hard edit");
    const tl = readDraft(e.id, "v1")!.timeline;
    expect(tl.plan?.kind).toBe("hard edit");
    // cut on the song's beats as measured (index.ts), no longer than the 3 s asked and less than a beat short of it
    const beats = await songBeats(path.join(dir, "song.wav"), 0, new AbortController().signal);
    const items = tl.tracks.V1.items;
    const end = items.at(-1)!.rec + items.at(-1)!.len;
    for (const i of items.slice(1)) expect(beats.beats.map((x) => Math.round(x * 30))).toContain(i.rec);
    expect(end).toBeLessThanOrEqual(90);
    expect(end).toBeGreaterThan(90 - (60 / beats.bpm) * 30);
    expect(items.find((i) => i.speed)?.speed).toBe(2);
    // a clip made from nothing, moving to the song under it, kept in the edit's own folder
    const gen = tl.sources[items[0]!.src]!;
    expect(gen).toMatchObject({ name: "Generated plasma", w: 320, h: 180, file: expect.stringMatching(/^gen\/[0-9a-f]{12}\.mp4$/) });
    expect(tl.tracks.A2.items).toEqual([{ src: "ver_song", in: 0, len: end, rec: 0 }]);
    const filed = readStep(e.id, "review")!.v1!;
    const v = (await readMeta(filed.assetId))!.versions[0]!;
    expect(v.status).toBe("ready");
    expect(Math.abs(v.duration - end / 30)).toBeLessThanOrEqual(0.1);
  }, 240_000);
});
