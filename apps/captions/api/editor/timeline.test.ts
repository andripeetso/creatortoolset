import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_EYELINE, type Line, type Sentence, type TimelineSource, type VersionPlan } from "../../contracts/editor";
import type { TimedWord } from "../library/transcribe";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-timeline-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-timeline-test-secret";

const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { saveTranscript } = await import("../library/transcribe");
const { ENERGY_PER_SECOND, energyFile } = await import("./analyze");
const { createEdit, editDir, readDraft, readStep, saveDraft, saveEdit, saveStep, viewOf, readEdit } = await import("./store");
const { buildTimeline, sourceOf, timecodeFrames } = await import("./timeline");
const { tick } = await import("./worker");
const { tiltFor } = await import("./framing");

/** Two sentences per file, each two 0.25 s words with a 0.1 s gap, sentences 1 s apart. */
const words: TimedWord[] = [
  { w: "we", s: 0.5, e: 0.75 },
  { w: "roll.", s: 0.85, e: 1.1 },
  { w: "join", s: 2.1, e: 2.35 },
  { w: "us.", s: 2.45, e: 2.7 },
];
const energy = new Float32Array(4 * ENERGY_PER_SECOND);
for (const w of words) energy.fill(0.5, Math.round(w.s * ENERGY_PER_SECOND), Math.round(w.e * ENERGY_PER_SECOND));
const sentences: Sentence[] = [
  { n: 1, src: "ver_a", text: "we roll.", s: 0.5, e: 1.1, w0: 0, w1: 1 },
  { n: 2, src: "ver_a", text: "join us.", s: 2.1, e: 2.7, w0: 2, w1: 3 },
  { n: 3, src: "ver_b", text: "we roll.", s: 0.5, e: 1.1, w0: 0, w1: 1 },
  { n: 4, src: "ver_b", text: "join us.", s: 2.1, e: 2.7, w0: 2, w1: 3 },
];
const lines: Line[] = [
  { id: "L1", text: "we roll", takes: [{ first: 1, last: 1, score: 1 }, { first: 3, last: 3, score: 0.9 }] },
  { id: "L2", text: "join us", takes: [{ first: 4, last: 4, score: 1 }, { first: 2, last: 2, score: 0.9 }] },
];
const plans: VersionPlan[] = [
  { name: "v1", title: "First", lines: [{ line: "L1", take: { first: 1, last: 1, score: 1 } }, { line: "L2", take: { first: 4, last: 4, score: 1 } }] },
  { name: "v2", title: "Second", lines: [{ line: "L2", take: { first: 2, last: 2, score: 0.9 } }, { line: "L1", take: { first: 3, last: 3, score: 0.9 } }] },
];
const probe = { duration: 4, width: 1920, height: 1080, fps: 25, rotation: 90, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac", timecode: "01:00:00:00" };

beforeAll(() => {
  const d = libraryDb();
  d.exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'mem-a', 'A', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_a', 'lib_a', 'video', 'Take A', 'mem-a', 0), ('ast_b', 'lib_a', 'video', 'Take B', 'mem-a', 0);
  `);
  for (const [v, a, fps] of [["ver_a", "ast_a", 25], ["ver_b", "ast_b", 50]] as const) {
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'mem-a', 0)").run(
      v,
      a,
      `libraries/lib_a/v/${v}/source`,
      `sha-${v}`,
      JSON.stringify({ ...probe, fps }),
    );
    saveTranscript(d, v, "deepgram", "en", [], words);
    mkdirSync(path.dirname(energyFile(v)), { recursive: true });
    writeFileSync(energyFile(v), energy);
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("AI Editor timeline", () => {
  it("reads start timecode, drop frame too, and turns a rotated source upright", () => {
    expect(timecodeFrames("01:00:00:00", 25)).toBe(90_000);
    expect(timecodeFrames("00:10:00;00", 29.97)).toBe(17_982);
    expect(timecodeFrames(undefined, 25)).toBe(0);
    expect(sourceOf("v", "Take A", { ...probe, fps: 25 })).toEqual({ versionId: "v", name: "Take A", fps: 25, tc: 90_000, dur: 100, w: 1080, h: 1920 });
  });

  it("lays each line's pieces on V1 and A1, linked, punches every other shot, a marker per line, frames at each rate", () => {
    const sources: Record<string, TimelineSource> = { ver_a: sourceOf("ver_a", "Take A", { ...probe, fps: 25 }), ver_b: sourceOf("ver_b", "Take B", { ...probe, fps: 50 }) };
    const { timeline: t, notes } = buildTimeline({
      name: "Tiny v1",
      plan: plans[0]!,
      lines,
      sentences,
      sources,
      words: { ver_a: words, ver_b: words },
      energy: { ver_a: energy, ver_b: energy },
      punch: 1.15,
      eyeline: {},
    });
    expect(notes).toEqual([]);
    expect([t.fps, t.width, t.height]).toEqual([25, 1080, 1920]);
    expect(t.markers.map((m) => [m.rec, m.name, m.note])).toEqual([[0, "L1", "we roll"], [t.tracks.V1.items[1]!.rec, "L2", "join us"]]);
    const [a, b] = t.tracks.V1.items;
    expect(a).toMatchObject({ src: "ver_a", rec: 0, link: "c1" });
    expect(a!.zoom).toBeUndefined();
    expect(b).toMatchObject({ src: "ver_b", rec: a!.len, link: "c2", zoom: 1.15 });
    // ver_b runs at 50 fps: its source frames are twice its timeline frames
    expect(b!.in).toBeGreaterThan(2 * 50);
    expect(t.tracks.A1.items.map((i) => [i.src, i.in, i.len, i.rec, i.link])).toEqual(t.tracks.V1.items.map((i) => [i.src, i.in, i.len, i.rec, i.link]));
    // the first take opens a little before "we" and closes a little after "roll."
    expect(a!.in).toBeLessThanOrEqual(Math.round(0.5 * 25));
    expect(a!.in + a!.len).toBeGreaterThanOrEqual(Math.round(1.1 * 25));
  });

  it("a working size of 1080x1920 from 4K vertical footage: the same cut and framing, its sources fitted into the smaller frame", async () => {
    const { shotFilter } = await import("./preview");
    const { toOtio } = await import("./otio");
    const { toFcpxml } = await import("./fcpxml");
    const uhd = { ...probe, width: 3840, height: 2160 };
    const sources: Record<string, TimelineSource> = { ver_a: sourceOf("ver_a", "Take A", { ...uhd, fps: 25 }), ver_b: sourceOf("ver_b", "Take B", { ...uhd, fps: 25 }) };
    const build = (size?: { w: number; h: number } | null) =>
      buildTimeline({ name: "Tiny v1", plan: plans[0]!, lines, sentences, sources, words: { ver_a: words, ver_b: words }, energy: { ver_a: energy, ver_b: energy }, punch: 1.3, eyeline: { ver_b: 0.3 }, size }).timeline;
    const own = build(null);
    const hd = build({ w: 1080, h: 1920 });
    expect([own.width, own.height, hd.width, hd.height]).toEqual([2160, 3840, 1080, 1920]);
    expect(build()).toEqual(own); // no size given: the footage's, as before
    // the same source frames in the same places; the tilt is in timeline pixels, so half as many
    expect(hd.sources).toEqual(own.sources);
    expect(hd.markers).toEqual(own.markers);
    expect(hd.tracks.A1).toEqual(own.tracks.A1);
    expect(hd.tracks.V1.items.map(({ tilt, ...i }) => i)).toEqual(own.tracks.V1.items.map(({ tilt, ...i }) => i));
    const tilts = hd.tracks.V1.items.map((i) => i.tilt ?? 0);
    expect(tilts.some((t) => t !== 0)).toBe(true);
    tilts.forEach((t, k) => expect(t).toBeCloseTo((own.tracks.V1.items[k]!.tilt ?? 0) / 2, 1));
    // the preview of both is 1080x1920 and frames each shot alike: the 4K source scaled down into the frame
    hd.tracks.V1.items.forEach((item, k) => expect(shotFilter(hd, item)).toBe(shotFilter(own, own.tracks.V1.items[k]!)));
    expect(shotFilter(hd, hd.tracks.V1.items[0]!)).toMatch(/^scale=1080:1920,.*pad=1080:1920:/);
    // the exports: FCPXML's sequence is 1080x1920, each clip at its own 2160x3840; OTIO names no frame size, and its
    // framing is a fraction of the fitted picture, so the same numbers
    const files = { ver_a: "/media/a.mov", ver_b: "/media/b.mov" };
    expect(toFcpxml(hd, files)).toContain(`<format id="r1" frameDuration="1/25s" width="1080" height="1920"/>`);
    expect(toFcpxml(hd, files)).toContain(`width="2160" height="3840"`);
    const params = (o: object) => [...JSON.stringify(o).matchAll(/"Parameter ID":"(transformation\w+)","Parameter Value":([-\d.e]+)/g)].map((m) => [m[1], Number(m[2])] as const);
    const [p1, p2] = [params(toOtio(hd, files)), params(toOtio(own, files))];
    expect(p1.length).toBeGreaterThan(0);
    expect(p1.map((x) => x[0])).toEqual(p2.map((x) => x[0]));
    p1.forEach(([, v], k) => expect(v).toBeCloseTo(p2[k]![1], 4));
  });

  it("the whole-edit draft queues one per version and drops drafts of versions no longer planned; each saves its timeline", async () => {
    const e = (await createEdit("mem-a", { sources: ["ver_a", "ver_b"], versions: 2 }))!;
    await saveStep(e.id, "analysis", { sentences, notes: [] });
    await saveStep(e.id, "plan", { lines, plans, notes: [] });
    await saveDraft(e.id, "v3", { timeline: {} as never, notes: [] });
    const v3copy = path.join(editDir(e.id), "post", "v3", "face-blur", "a-1.mov");
    mkdirSync(path.dirname(v3copy), { recursive: true });
    writeFileSync(v3copy, "x");
    await saveStep(e.id, "post", { v3: { files: { ver_a: v3copy }, notes: [] } });
    enqueueJob(libraryDb(), "mem-a", `${e.id}:`, "draft", "mem-a", true, "edit_jobs");
    while (await tick());
    const jobs = viewOf(readEdit(e.id)!).jobs.map((j) => [j.kind, j.variant, j.kind === "draft" ? j.state : ""]);
    // each version's draft queues its B-roll, then its post-processing (no steps: nothing to do), then its preview (it fails
    // here: the fixture has no footage); the whole-edit one none
    expect(jobs).toEqual([
      ["draft", "", "done"],
      ["draft", "v1", "done"],
      ["draft", "v2", "done"],
      ["broll", "v1", ""],
      ["broll", "v2", ""],
      ["post", "v1", ""],
      ["post", "v2", ""],
      ["preview", "v1", ""],
      ["preview", "v2", ""],
    ]);
    expect(viewOf(readEdit(e.id)!).drafts).toEqual(["v1", "v2"]);
    // the dropped version's post copies go too
    expect(existsSync(path.join(editDir(e.id), "post", "v3"))).toBe(false);
    expect(readStep(e.id, "post")?.v3).toBeUndefined();
    const v2 = readDraft(e.id, "v2")!.timeline;
    expect(v2.tracks.V1.items.map((i) => i.src)).toEqual(["ver_a", "ver_b"]);
    expect(Object.keys(v2.sources).sort()).toEqual(["ver_a", "ver_b"]);
  });

  it("a draft keeps the eye line the person set, else the one found at analyze, else the default", async () => {
    const e = (await createEdit("mem-a", { sources: ["ver_a", "ver_b"], versions: 1 }))!;
    await saveEdit({ ...readEdit(e.id)!, eyeline: { ver_b: 0.45 } });
    await saveStep(e.id, "analysis", { sentences, notes: [], eyeline: { ver_a: 0.25, ver_b: 0.25 } });
    // shots: ver_a wide, ver_b punched, ver_b wide, ver_a punched
    const take = (n: number) => ({ first: n, last: n, score: 1 });
    const four = { name: "v1", title: "Four", lines: [{ line: "L1", take: take(1) }, { line: "L2", take: take(4) }, { line: "L1", take: take(3) }, { line: "L2", take: take(2) }] };
    await saveStep(e.id, "plan", { lines, plans: [four], notes: [] });
    enqueueJob(libraryDb(), "mem-a", `${e.id}:v1`, "draft", "mem-a", true, "edit_jobs");
    while (await tick());
    expect(viewOf(readEdit(e.id)!).eyelineFound).toEqual({ ver_a: 0.25, ver_b: 0.25 });
    const t = readDraft(e.id, "v1")!.timeline;
    const punched = t.tracks.V1.items.filter((i) => i.zoom);
    expect(punched.map((i) => i.src)).toEqual(["ver_b", "ver_a"]);
    const tilt = (src: string, y: number) => tiltFor(t.sources[src]!, t.width, t.height, punched[0]!.zoom!, y);
    expect(punched.map((i) => i.tilt)).toEqual([tilt("ver_b", 0.45), tilt("ver_a", 0.25)]);
    // none found and none set: the default, as before
    await saveStep(e.id, "analysis", { sentences, notes: [] });
    await saveEdit({ ...readEdit(e.id)!, eyeline: {} });
    enqueueJob(libraryDb(), "mem-a", `${e.id}:v1`, "draft", "mem-a", true, "edit_jobs");
    while (await tick());
    expect(readDraft(e.id, "v1")!.timeline.tracks.V1.items.filter((i) => i.zoom).map((i) => i.tilt)).toEqual([tilt("ver_b", DEFAULT_EYELINE), tilt("ver_a", DEFAULT_EYELINE)]);
  });
});
