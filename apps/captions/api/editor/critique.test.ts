import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditPlan, IndexSource } from "../../contracts/edit-plan";
import type { Timeline } from "../../contracts/editor";
import { ffmpegCommand } from "../ffmpeg-runtime";

// the person's AI: the look and the fix are the test's answers
vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(() => ({ only: ["mac"] })), completeWithFallback: vi.fn() };
});
vi.mock("../ai-vision", () => ({ completeVisionWithFallback: vi.fn() }));

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-critique-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-critique-test-secret";

const { completeWithFallback } = await import("../ai-complete");
const { completeVisionWithFallback } = await import("../ai-vision");
const { MacClaudeError } = await import("../lib/mac-claude");
const { blobs, libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { readMeta } = await import("../review");
const { critiquePrompt, parseCritique, shotFrames, withFlaws } = await import("./critique");
const { nextFor } = await import("./engine");
const { shotLog } = await import("./index");
const { addFeedback, createEdit, readDraft, readEdit, readStep, saveDraft, saveEdit, saveStep } = await import("./store");
const { lastLook } = await import("./plan");
const { emptyTracks } = await import("./timeline");
const { NEXT, tick } = await import("./worker");

const db = () => libraryDb();
const ph = (seed: string) => createHash("sha256").update(seed).digest("hex").slice(0, 16);
const NOTE = "No walking around town.\nKeep the jump!";
const TOWN = "walking through town, nothing happens";

/** Two made-up recordings with sound, 10 s each, described every 2 s by the library. */
const FILES = [
  { v: "ver_a", title: "Tiny Acrobatics arena", src: "testsrc", line: (k: number) => ({ action: 4, tags: ["fight"], text: `a rider fights at the gate, part ${k}` }) },
  { v: "ver_b", title: "Tiny Acrobatics town", src: "testsrc2", line: (k: number) => ({ action: 1, tags: ["walk", "town"], text: `a person walks through town, part ${k}` }) },
];

/** The cut the AI planned: three shots of 1 s, the middle one the town walk. */
const PLAN: EditPlan = {
  kind: "hard edit",
  w: 320,
  h: 180,
  fps: 30,
  lead: { type: "sources" },
  shots: [
    { at: 0, dur: 1, src: { source: "ver_a", inS: 0 }, sound: "full", why: "the jump" },
    { at: 1, dur: 1, src: { source: "ver_b", inS: 2 }, fx: [{ type: "punch", at: 0.2, amount: 1.2 }], sound: "full", why: "town scenery" },
    { at: 2, dur: 1, src: { source: "ver_a", inS: 6 }, sound: "full", why: "the landing" },
  ],
};

let clock = 10 ** 13;
/** Queues `kind` for the edit's v1 and runs the worker until nothing is left to run now (the file step waits for Review, a limit far longer). */
async function run(e: { id: string; workspaceId: string }, kind: string) {
  enqueueJob(db(), e.workspaceId, `${e.id}:v1`, kind, "mem-a", true, "edit_jobs");
  for (let i = 0; i < 400; i++) {
    if (!db().prepare("SELECT 1 FROM edit_jobs WHERE edit_id = ? AND (state = 'running' OR (state = 'queued' AND run_after <= ?))").get(e.id, clock + 60_000)) break;
    await tick((clock += 60_000));
    await new Promise((r) => setTimeout(r, 50));
  }
  return db().prepare("SELECT kind, state, error FROM edit_jobs WHERE edit_id = ? ORDER BY id").all(e.id);
}

/** A planned edit of both recordings, its plan written as the plan step writes it, with a note and a style. */
async function planned() {
  const e = (await createEdit("mem-a", { name: "Tiny Acrobatics hard edit", sources: ["ver_a", "ver_b"] }))!;
  await saveEdit({ ...e, brief: "A hard edit, 3 seconds", style: { id: "s1", name: "Hard edit", notes: "Cut on every beat.", pace: "tight" } as never });
  await addFeedback(e.id, [{ at: 1, from: "chat", by: "mem-a", text: NOTE }]);
  await saveStep(e.id, "shots", { v1: { plan: PLAN, notes: [] } });
  await saveStep(e.id, "plan", { lines: [], plans: [{ name: "v1", title: "Hard edit", lines: [] }], notes: [], at: 1 });
  return readEdit(e.id)!;
}

/** What the look is asked, and how many pictures it is shown; `answers` in turn. */
let looks: { user: string; images: string[] }[] = [];
let answers: unknown[] = [];
let fixes: string[] = [];
const doneAll = (kinds: string[]) => kinds.map((kind) => ({ kind, state: "done", error: null }));

beforeAll(async () => {
  db().exec("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'mem-a', 'A', 'local', 0)");
  for (const f of FILES) {
    const file = path.join(dir, `${f.v}.mp4`);
    execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", `${f.src}=duration=10:size=320x180:rate=30`, "-f", "lavfi", "-i", "sine=frequency=440:duration=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
    const probe = JSON.stringify({ duration: 10, width: 320, height: 180, fps: 30, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" });
    db().prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, 'mem-a', 0)").run(`a_${f.v}`, f.title);
    db().prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'mem-a', 0)").run(f.v, `a_${f.v}`, `libraries/lib_a/v/${f.v}/source`, `s_${f.v}`, probe);
    await blobs.put(`libraries/lib_a/v/${f.v}/source`, file);
  }
  const q = db().prepare("INSERT INTO stretches (version_id, seg, a, b, motion, action, clear, tags, text, ph, source, stamp, created_at) VALUES (?, ?, ?, ?, 0.5, ?, 1, ?, ?, ?, 'ai', ?, 0)");
  // each file's lines under the stamp the library writes them with (shots.ts lookStamp)
  for (const f of FILES) {
    const stamp = await shotLog.stamp(f.v);
    for (let k = 0; k < 5; k++) q.run(f.v, k, k * 2, k * 2 + 2, f.line(k).action, JSON.stringify(f.line(k).tags), f.line(k).text, ph(`${f.v}:${k}`), stamp);
  }
  shotLog.first = () => {};
  shotLog.redo = () => false;
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  looks = [];
  answers = [];
  fixes = [];
  vi.mocked(completeVisionWithFallback).mockImplementation(async (_s, user, images, _sig, parse) => {
    looks.push({ user, images: images.map((i) => i.jpegBase64) });
    const a = answers[looks.length - 1] ?? { ok: true, fails: [] };
    if (a instanceof Error) throw a;
    return { value: parse(JSON.stringify(a)), provider: "mac" };
  });
  // a plan asked for after the look: there must be none (no fix round, owner 2026-11-19)
  vi.mocked(completeWithFallback).mockImplementation(async (_s, user, _sig, parse) => {
    fixes.push(user);
    return parse(JSON.stringify({ plans: [{ shots: [{ keep: 1 }, { src: "S1", in: 3, dur: 2.5, fx: [], why: "the fight at the gate" }, { keep: 3 }] }] }));
  });
});

describe("the look at a planned cut before Review", () => {
  it("a cut that passes costs one look and is filed as before, with nothing named on it", async () => {
    const e = await planned();
    expect(await run(e, "draft")).toEqual(doneAll(["draft", "broll", "post", "preview", "critique", "file"]));
    expect(looks).toHaveLength(1);
    expect(fixes).toHaveLength(0);
    // one sheet: three shots, two frames each, from the rendered cut
    expect(looks[0]!.images).toHaveLength(1);
    expect(looks[0]!.images[0]!.startsWith("/9j/")).toBe(true);
    const u = looks[0]!.user;
    expect(u).toContain("Brief:\nA hard edit, 3 seconds");
    expect(u).toContain(`The person's own words on earlier versions, word for word, oldest first (the newest says what they want now):\n- In chat: ${JSON.stringify(NOTE)}`);
    expect(u).toContain('Editing style "Hard edit", in the author\'s own words:\nCut on every beat.');
    expect(u).toContain('2. 1.00–2.00 s · "Tiny Acrobatics town" at 0:02 · a1 clear · walk, town · a person walks through town, part 1 · picked: town scenery');
    expect(u).toContain("picture 1 holds shots 1–3");
    expect(critiquePrompt({ brief: "", notes: [], style: "", shots: Array.from({ length: 9 }, (_, k) => `${k + 1}.`), sheets: 2, seconds: 9, song: false }).user).toContain("picture 2 holds shot 9.");
    const v = (await readMeta(readStep(e.id, "review")!.v1!.assetId))!.versions;
    expect(v.map((x) => x.n)).toEqual([1]);
    expect(v[0]!.draft).toEqual({ edit: e.id, name: "v1", by: "mem-a" });
    expect(readDraft(e.id, "v1")).toMatchObject({ critique: { ok: true, fails: [], round: 1 } });
    expect(readDraft(e.id, "v1")!.due).toBeUndefined();
  }, 120_000);

  it("a failed check files the cut it ran on, its failing shots named, and makes no second draft", async () => {
    const e = await planned();
    answers = [{ ok: false, fails: [{ n: 2, why: TOWN }] }];
    // one draft, one look, filed: no fix round's plan, draft or second look (owner, 2026-11-19: "He never wants a draft he didn't ask for")
    expect(await run(e, "draft")).toEqual(doneAll(["draft", "broll", "post", "preview", "critique", "file"]));
    expect(looks).toHaveLength(1);
    expect(fixes).toHaveLength(0);
    expect(readStep(e.id, "shots")!.v1).toEqual({ plan: PLAN, notes: [] });
    const v = (await readMeta(readStep(e.id, "review")!.v1!.assetId))!.versions;
    expect(v).toHaveLength(1);
    expect(v[0]!.draft).toEqual({ edit: e.id, name: "v1", by: "mem-a", fails: [{ n: 2, why: TOWN, at: 1, dur: 1 }] });
    const d = readDraft(e.id, "v1")!;
    expect([d.due, d.critique]).toEqual([undefined, { ok: false, fails: [{ n: 2, why: TOWN, at: 1, dur: 1 }], round: 1 }]);
  }, 120_000);

  it("a cut the person saved (not the AI's) is never looked at: its preview is filed as before", async () => {
    expect(nextFor("preview", {}, NEXT)).toEqual(["file"]);
    expect(nextFor("preview", {}, NEXT, [], true)).toEqual(["critique"]);
    const e = (await createEdit("mem-a", { name: "Tiny Acrobatics talk", sources: ["ver_a"] }))!;
    const t: Timeline = { name: "Talk v1", fps: 30, width: 320, height: 180, sources: { ver_a: { versionId: "ver_a", name: "Talk", fps: 30, tc: 0, dur: 300, w: 320, h: 180 } }, tracks: emptyTracks(), markers: [] };
    t.tracks.V1.items = [{ src: "ver_a", in: 0, len: 30, rec: 0, link: "c1" }];
    t.tracks.A1.items = [{ src: "ver_a", in: 0, len: 30, rec: 0, link: "c1" }];
    await saveDraft(e.id, "v1", { timeline: t, notes: [] });
    expect(await run(e, "preview")).toEqual(doneAll(["preview", "file"]));
    expect(looks).toHaveLength(0);
  }, 120_000);

  it("a usage limit during the look never holds the cut: it is filed at once, with one line saying it was not looked at and why", async () => {
    const e = await planned();
    const until = clock + 10 ** 9;
    answers = [Object.assign(new MacClaudeError("Your Claude plan's 5-hour limit is reached; it resets 5pm.", "limit"), { limited: { until } })];
    expect(await run(e, "draft")).toEqual(doneAll(["draft", "broll", "post", "preview", "critique", "file"]));
    expect(looks).toHaveLength(1);
    const line = "Not checked before Review: Your Claude plan's 5-hour limit is reached; it resets 5pm";
    const v = (await readMeta(readStep(e.id, "review")!.v1!.assetId))!.versions;
    expect(v).toHaveLength(1);
    // the line rides where the failing shots are named, as shot 0: no shot's own
    expect(v[0]!.draft).toEqual({ edit: e.id, name: "v1", by: "mem-a", fails: [{ n: 0, why: line }] });
    const d = readDraft(e.id, "v1")!;
    expect([d.due, d.critique, d.unchecked]).toEqual([undefined, undefined, line]);
  }, 120_000);

  it("the look carries the workspace's context, so it can tell what the footage is of", async () => {
    const file = path.join(dir, "workshop", "projects", "p-tiny.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ id: "p-tiny", owner: "mem-a", name: "Tiny Acrobatics", audience: "", voice: "", cta: "", notes: "A game about riders at a castle gate.", createdAt: 1, updatedAt: 1 }));
    try {
      const e = await planned();
      await run(e, "draft");
      expect(looks[0]!.user).toMatch(/^Brief:\nA hard edit, 3 seconds\n\nThe workspace's setup:\n[\s\S]*A game about riders at a castle gate\.[\s\S]*\n\nThe person's own words/);
    } finally {
      rmSync(file);
    }
  }, 120_000);
});

describe("the look at a cut around speech before Review", () => {
  it("is looked at shot by shot with what is said, and the render's own problems are named on it", async () => {
    const e = (await createEdit("mem-a", { name: "Tiny Acrobatics talk", sources: ["ver_a"] }))!;
    const src = { versionId: "ver_a", name: "Tiny Acrobatics arena", fps: 30, tc: 0, dur: 300, w: 320, h: 180 };
    // the last shot is a take with no picture (as a recorder's is): the render ends on black
    const t: Timeline = { name: "Talk v1", fps: 30, width: 320, height: 180, sources: { ver_a: src, ver_b: { ...src, versionId: "ver_b", name: "Recorder", w: 0, h: 0 } }, tracks: emptyTracks(), markers: [] };
    const shots = [["ver_a", 0], ["ver_a", 100], ["ver_b", 0]] as const;
    t.tracks.V1.items = shots.map(([s, i], k) => ({ src: s, in: i, len: 30, rec: 30 * k, link: `c${k + 1}` }));
    t.tracks.A1.items = shots.map(([s, i], k) => ({ src: s, in: i, len: 30, rec: 30 * k, link: `c${k + 1}` }));
    await saveDraft(e.id, "v1", { timeline: t, notes: [], due: 1 });
    expect(await run(e, "preview")).toEqual(doneAll(["preview", "critique", "file"]));
    expect(looks).toHaveLength(1);
    expect(looks[0]!.user).toContain('1. 0.00–1.00 s · speaker · "Tiny Acrobatics arena" at 0:00');
    expect(looks[0]!.user).toContain('2. 1.00–2.00 s · speaker · "Tiny Acrobatics arena" at 0:03');
    expect(looks[0]!.user).toContain('3. 2.00–3.00 s · speaker · "Recorder" at 0:00');
    const black = { n: 3, why: "the video ends on black", at: 2, dur: 1 };
    const v = (await readMeta(readStep(e.id, "review")!.v1!.assetId))!.versions;
    expect(v[0]!.draft).toEqual({ edit: e.id, name: "v1", by: "mem-a", fails: [black] });
    expect(readDraft(e.id, "v1")).toMatchObject({ critique: { ok: false, fails: [black] } });
  }, 120_000);

  it("reads the shots its picture shows: a cutaway over the speaker plays where it lies", async () => {
    const { pictureShots } = await import("./critique");
    const t: Timeline = { name: "t", fps: 30, width: 320, height: 180, sources: { a: { versionId: "a", name: "A", fps: 60, tc: 0, dur: 9000, w: 320, h: 180 } }, tracks: emptyTracks(), markers: [] };
    t.tracks.V1.items = [{ src: "a", in: 0, len: 15, rec: 0 }, { src: "a", in: 30, len: 75, rec: 15 }];
    // the cutaway runs over his cut at 0.5 s: one shot, 1 s long
    t.tracks.V2.items = [{ src: "b", in: 30, len: 30, rec: 10 }];
    const r = (x: number) => Math.round(x * 1000) / 1000;
    expect(pictureShots(t).map((s) => ({ ...s, at: r(s.at), dur: r(s.dur), inS: r(s.inS) }))).toEqual([
      { at: 0, dur: 0.333, src: "a", inS: 0, cutaway: false },
      { at: 0.333, dur: 1, src: "b", inS: 1, cutaway: true },
      { at: 1.333, dur: 1.667, src: "a", inS: 1.333, cutaway: false },
    ]);
  });
});

describe("the look's parts", () => {
  it("takes two frames inside every shot, always later than the one before", () => {
    const f = shotFrames({ fps: 30, shots: [{ at: 0, dur: 1 }, { at: 1, dur: 0.2 }, { at: 1.2, dur: 1 / 30 }, { at: 1.2 + 1 / 30, dur: 10 }] as EditPlan["shots"] });
    expect(f).toEqual([8, 21, 32, 33, 36, 37, 67, 306]);
  });

  it("reads only shots of the cut, each once with a reason, and passes when none is named", () => {
    expect(parseCritique('{"ok": false, "fails": [{"n": 3, "why": "dull"}, {"n": 3, "why": "again"}, {"n": 9, "why": "no such shot"}, {"n": 1, "why": " "}, {"n": 2, "why": "dark"}]}', 4, 1)).toEqual({
      ok: false,
      fails: [{ n: 2, why: "dark" }, { n: 3, why: "dull" }],
      round: 1,
    });
    expect(parseCritique('{"ok": false, "fails": []}', 4, 2)).toEqual({ ok: true, fails: [], round: 2 });
    // given the shots, each named one keeps its place in the cut, for Review's timeline
    expect(parseCritique('{"fails": [{"n": 2, "why": "dark"}]}', [{ at: 0, dur: 1 }, { at: 1, dur: 1.5 }], 1).fails).toEqual([{ n: 2, why: "dark", at: 1, dur: 1.5 }]);
  });

  it("a shot of footage measured as badly taken fails for it, unless the AI named it already", () => {
    const shown = [{ a: 0, b: 2, motion: 0.5, flaws: ["blurry"] }, undefined, { a: 4, b: 6, motion: 0.5, flaws: ["too dark", "shaky"] }, { a: 6, b: 8, motion: 0.5, quality: 0.9 }];
    expect(withFlaws({ ok: false, fails: [{ n: 3, why: "dull" }], round: 1 }, shown, [{ at: 0, dur: 1 }])).toEqual({
      ok: false,
      fails: [{ n: 1, why: "blurry", at: 0, dur: 1 }, { n: 3, why: "dull" }],
      round: 1,
    });
    expect(withFlaws({ ok: true, fails: [], round: 1 }, [undefined, { a: 0, b: 1, motion: 0 }])).toEqual({ ok: true, fails: [], round: 1 });
  });

  it("the last look never moves a shot onto a picture the cut already shows", async () => {
    // a recording that is black all through: the last look moves its shot to the best moment of the arena
    const file = path.join(dir, "ver_dark.mp4");
    execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "color=black:duration=1:size=320x180:rate=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    db().exec("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('a_ver_dark', 'lib_a', 'video', 'Dark', 'mem-a', 0)");
    db().exec("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_dark', 'a_ver_dark', 1, 'libraries/lib_a/v/ver_dark/source', 1, 's_dark', 'ready', 'mem-a', 0)");
    await blobs.put("libraries/lib_a/v/ver_dark/source", file);
    const line = (k: number, action: number, picture: string) => ({ a: k * 2, b: k * 2 + 2, motion: 0.5, action, clear: true, ph: ph(picture) });
    const src = (id: string, dur: number, shots: IndexSource["shots"]): IndexSource => ({ id, title: id, dur, fps: 30, w: 320, h: 180, speech: false, sound: true, shots });
    // the arena's busiest stretch (2-4 s) shows the gate again, the picture the cut opens on; the jump (4-6 s) is not shown yet
    const arena = src("ver_a", 10, [line(0, 3, "gate"), line(1, 5, "gate"), line(2, 2, "jump"), line(3, 1, "walk"), line(4, 1, "rest")]);
    const dark = src("ver_dark", 1, [{ a: 0, b: 1, motion: 0, action: 1, clear: false, ph: ph("dark") }]);
    const plan: EditPlan = { ...PLAN, shots: [{ at: 0, dur: 1, src: { source: "ver_a", inS: 0 }, sound: "full" }, { at: 1, dur: 1, src: { source: "ver_dark", inS: 0 }, sound: "full" }] };
    expect(await lastLook(plan, { sources: [arena, dark] })).toBe(1);
    expect(plan.shots[1]!.src).toEqual({ source: "ver_a", inS: 4 });
  }, 60_000);

  it("asks one judgement of the whole cut, with no notes or style when there are none", () => {
    const { system, user } = critiquePrompt({ brief: "", notes: [], style: "", shots: ["1. 0.00–1.00 s · x"], sheets: 1, seconds: 1, song: true });
    // no workspace context: the prompt is what it was
    expect(critiquePrompt({ brief: "", workspace: " ", notes: [], style: "", shots: ["1. 0.00–1.00 s · x"], sheets: 1, seconds: 1, song: true }).user).toBe(user);
    expect(user).not.toContain("workspace");
    expect(user).not.toContain("own words");
    expect(user).toContain("The cut: 1.0 s, 1 shots, cut to a song.");
    expect(system).toContain('"fails"');
  });
});
