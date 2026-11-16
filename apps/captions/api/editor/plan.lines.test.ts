import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EditPlan, FootageIndex, IndexSource } from "../../contracts/edit-plan";
import type { EditFeedback } from "../../contracts/editor";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-plan-lines-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-plan-lines-test-secret";

const { LINES_MAX, planPrompt, repairPlan, reviseOf } = await import("./plan");
const { samePicture } = await import("../library/look");
const { saveStep } = await import("./store");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A picture hash far from every other (64 random-looking bits). */
const ph = (seed: string) => createHash("sha256").update(seed).digest("hex").slice(0, 16);
const WORDS = "a person on a horse rides past the castle gate while two more fight by the fountain under a red sky";

/** A source with the library's shot descriptions: a line every `len` s, action by `act`, picture hashes all apart. */
function logged(id: string, n: number, act: (k: number) => number = (k) => k % 6, len = 6): IndexSource {
  return {
    id,
    title: `Tiny Acrobatics ${id}`,
    dur: n * len,
    fps: 30,
    w: 1920,
    h: 1080,
    speech: false,
    sound: true,
    shots: Array.from({ length: n }, (_, k) => ({ a: k * len, b: (k + 1) * len, motion: 0.5, desc: `${id} line ${k}: ${WORDS}`, action: act(k), clear: k % 2 === 0, tags: ["ride", "fight"], ph: ph(`${id}:${k}`) })),
  };
}
/** A source read the editor's own way: shots with motion only. */
const plain = (id: string, n: number): IndexSource => ({ id, title: id, dur: n * 4, fps: 30, w: 1920, h: 1080, speech: false, sound: true, shots: Array.from({ length: n }, (_, k) => ({ a: k * 4, b: k * 4 + 4, motion: (k % 5) / 5 })) });
const input = (index: FootageIndex, over: object = {}) => ({ brief: "A hard edit", versions: 1, targetS: 0, setup: "", index, words: {}, gen: [], ...over });
const lineRows = (user: string) => user.split("\n").filter((l) => /^S\d+ \d+:\d\d\.\d–/.test(l));

describe("the plan reads the whole shot log", () => {
  it("gives every line of a source with shot descriptions, and the strongest shots of one without", () => {
    const { user } = planPrompt(input({ sources: [logged("ver_a", 40), logged("ver_b", 25), plain("ver_c", 50)] }));
    const rows = lineRows(user);
    expect(rows.filter((l) => l.startsWith("S1 "))).toHaveLength(40);
    expect(rows.filter((l) => l.startsWith("S2 "))).toHaveLength(25);
    expect(rows).toContain(`S1 0:00.0–0:06.0 a0 clear · ride, fight · ver_a line 0: ${WORDS}`.slice(0, `S1 0:00.0–0:06.0 a0 clear · ride, fight · `.length + 100));
    expect(rows).toContain(`S1 3:54.0–4:00.0 a3 · ride, fight · ${`ver_a line 39: ${WORDS}`.slice(0, 100)}`);
    expect(user).toContain("Shot lines: S<n> start–end");
    // motion is not action (walking scrolls the whole picture): a described source's lines never show it
    expect(rows.some((l) => l.includes("motion"))).toBe(false);
    // the source without lines is sampled as before
    expect(user).toMatch(/S3 "ver_c".*\n {2}\d+ of its 50 shots:/);
  });

  it("keeps at most LINES_MAX lines in all: every line with action 2 or more, then the rest by action", () => {
    const { user } = planPrompt(input({ sources: [logged("ver_a", 600), logged("ver_b", 600), logged("ver_c", 600)] }));
    const rows = lineRows(user);
    expect(rows).toHaveLength(LINES_MAX);
    // 1,200 lines have action 2-5, 300 have 1: those fill the rest, none with 0
    expect(rows.filter((l) => / a[2-5] /.test(l))).toHaveLength(1200);
    expect(rows.filter((l) => / a1 /.test(l))).toHaveLength(300);
    expect(rows.some((l) => / a0 /.test(l))).toBe(false);
    // each source keeps its lines with action 1 or more
    expect(user).toContain("  500 of its 600 shot lines (the busiest):");
  });

  it("measures the prompt for 1,000 lines", () => {
    const sources = [logged("ver_a", 400), logged("ver_b", 350), logged("ver_c", 250)];
    const { system, user } = planPrompt(input({ sources }));
    expect(lineRows(user)).toHaveLength(1000);
    const chars = system.length + user.length;
    // eslint-disable-next-line no-console -- the number goes in the report
    console.log(`plan prompt for 1,000 lines: ${chars} characters, about ${Math.round(chars / 4)} tokens`);
    expect(chars).toBeLessThan(200_000);
  });
});

describe("a revise starts from the last version", () => {
  const index = (): FootageIndex => ({ sources: [logged("ver_a", 20), logged("ver_b", 20)] });
  const ctx = (over: object = {}) => ({ index: index(), targetS: 0, size: { w: 1080, h: 1920, fps: 30 }, fixedSize: true, gen: [], brief: "A calm recap", ...over });
  const first = (): EditPlan =>
    repairPlan(
      {
        kind: "hard edit",
        shots: [
          { src: "S1", in: 12, dur: 1, fx: [{ type: "punch", at: 0 }], why: "the jump" },
          { src: "S1", in: 30, dur: 1.5, why: "the town" },
          { src: "S2", in: 6, dur: 0.8, fx: [{ type: "flash", at: 0.1 }, { type: "shake", at: 0.2 }], why: "the fight" },
          { src: "S2", in: 60, dur: 1.2, speed: 2, why: "the gate" },
        ],
        texts: [{ at: 0, dur: 1, text: "Tiny Acrobatics" }],
      },
      ctx(),
    ).plan;

  it("reads the notes word for word, oldest first, and the last shots with the ones a note sits on", async () => {
    const last = first();
    const id = randomUUID();
    mkdirSync(path.join(dir, "editor", id), { recursive: true });
    await saveStep(id, "shots", { v1: { plan: last, notes: [] } });
    await saveStep(id, "plan", { lines: [], plans: [], notes: [], at: 1000 });
    const notes: EditFeedback[] = [
      { at: 500, from: "review", variant: "v1", t: 0.5, text: "an older cut's note", by: "maker" },
      { at: 1500, from: "chat", variant: "v1", text: "No walking around town. Keep the jump!", by: "maker" },
      { at: 2000, from: "review", variant: "v1", t: 1.4, text: "this one's dull", by: "maker" },
    ];
    const revise = reviseOf({ id, feedback: notes })!;
    // the Review note made since the last plan sits on shot 2 (1.0-2.5 s); the older one is about an older cut
    expect(revise.last).toEqual([{ name: "v1", plan: last, marked: [1] }]);
    const { user } = planPrompt(input(index(), { revise }));
    expect(user).toContain('- In chat about v1: "No walking around town. Keep the jump!"');
    expect(user).toContain(`- In Review on v1 at 1.4 s: "this one's dull"`);
    expect(user.indexOf("an older cut's note")).toBeLessThan(user.indexOf("No walking around town"));
    expect(user).toContain("  1. S1 in 12.0, 1.00 s, punch: the jump");
    expect(user).toContain("  2. S1 in 30.0, 1.50 s: the town  ← a note sits on this shot");
    expect(user).toContain('{"keep": n}');
    // no notes, or no last version: a first plan, as before
    expect(reviseOf({ id, feedback: [] })).toBeNull();
    expect(reviseOf({ id: randomUUID(), feedback: notes })).toBeNull();
  });

  it("copies the slots it keeps exactly and fills the ones it changes", () => {
    const last = first();
    const { plan, notes } = repairPlan({ kind: "hard edit", shots: [{ keep: 1 }, { src: "S2", in: 90, dur: 1.5, why: "a fight" }, { keep: 3 }, { keep: 4 }, { keep: 9 }] }, ctx({ last }));
    expect(plan.shots[0]).toEqual(last.shots[0]);
    expect(plan.shots[2]).toEqual(last.shots[2]);
    expect(plan.shots[3]).toEqual(last.shots[3]);
    expect(plan.shots[1]).toMatchObject({ at: last.shots[1]!.at, dur: last.shots[1]!.dur, src: { source: "ver_b", inS: 90 }, why: "a fight" });
    expect(notes).toContain("The AI kept shot 9 of the last version, which it does not have: left out");
  });
});

describe("a source with shot descriptions is ranked by action, never by motion", () => {
  // the dull stretches move the most, as walking does in gameplay; stretch 7 is the fight
  const busy = () => {
    const s = logged("ver_b", 10, (k) => (k === 7 ? 5 : 0));
    for (const x of s.shots) x.motion = x.action === 5 ? 0.1 : 1;
    return s;
  };
  const ctx = (index: FootageIndex, brief = "") => ({ index, targetS: 0, size: { w: 1080, h: 1920, fps: 30 }, fixedSize: true, gen: [], brief });

  it("takes the busiest stretch for a shot with no room left in its own source", () => {
    const { plan } = repairPlan({ shots: [{ src: "S1", in: 0, dur: 2 }, { src: "S1", in: 0, dur: 2 }] }, ctx({ sources: [{ ...plain("ver_a", 1), dur: 2, shots: [{ a: 0, b: 2, motion: 0.5 }] }, busy()] }));
    expect(plan.shots[1]!.src).toEqual({ source: "ver_b", inS: 42 });
  });

  it("opens on the busiest stretch of the source the brief names with no moment", () => {
    const { plan } = repairPlan({ shots: [{ src: "S1", in: 0, dur: 1 }] }, ctx({ sources: [plain("ver_a", 5), busy()] }, "Start with S2"));
    expect(plan.shots[0]!.src).toEqual({ source: "ver_b", inS: 42 });
  });
});

describe("the same picture is shown once", () => {
  it("replaces a later shot whose picture is already in the cut with the next best stretch not shown", () => {
    const a = logged("ver_a", 10, () => 3);
    const b = logged("ver_b", 10, (k) => (k === 7 ? 5 : 1));
    // the character select screen, in both recordings
    b.shots[2]!.ph = a.shots[0]!.ph;
    const index: FootageIndex = { sources: [a, b] };
    const { plan, notes } = repairPlan(
      { shots: [{ src: "S1", in: 0, dur: 1 }, { src: "S1", in: 30, dur: 1 }, { src: "S2", in: 12.5, dur: 1 }] },
      { index, targetS: 0, size: { w: 1080, h: 1920, fps: 30 }, fixedSize: true, gen: [] },
    );
    // the third shot showed S1's first picture: the busiest stretch not shown takes its place
    expect(plan.shots[2]!.src).toEqual({ source: "ver_b", inS: 42 });
    expect(notes).toContain("1 shot showed a picture already in the edit: the next best footage not shown yet is in its place");
    const phs = plan.shots.map((s) => {
      const at = s.src as { source: string; inS: number };
      return (at.source === "ver_a" ? a : b).shots.find((x) => x.a <= at.inS && at.inS < x.b)!.ph!;
    });
    for (const [i, p] of phs.entries()) for (const q of phs.slice(i + 1)) expect(samePicture(p, q)).toBe(false);
  });

  it("keeps a shot just after another in a source with shot descriptions where it was planned (no 0.5 s spacing)", () => {
    const { plan } = repairPlan(
      { shots: [{ src: "S1", in: 5, dur: 1 }, { src: "S1", in: 6.1, dur: 1 }] },
      { index: { sources: [logged("ver_a", 10)] }, targetS: 0, size: { w: 1080, h: 1920, fps: 30 }, fixedSize: true, gen: [] },
    );
    expect(plan.shots.map((s) => "source" in s.src && s.src.inS)).toEqual([5, 6.1]);
  });
});
