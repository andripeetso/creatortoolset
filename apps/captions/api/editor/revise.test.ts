import { describe, expect, it, vi } from "vitest";
import type { Timeline } from "../../contracts/editor";

// the step's world: one draft filed in Review as version 2, its comments, the AI's answer
const w = vi.hoisted(() => ({
  comments: [] as Record<string, unknown>[],
  answered: [] as unknown[],
  saved: [] as unknown[],
  queued: [] as unknown[],
  asked: [] as string[],
  answer: "",
  timeline: null as unknown,
}));
vi.mock("../review", () => ({
  readComments: async () => w.comments,
  answerComments: async (...a: unknown[]) => void w.answered.push(a),
  frameJpeg: async () => Buffer.from("jpeg"),
  refLooks: async () => [],
  sourcePath: () => "/nowhere",
}));
vi.mock("./store", () => ({
  readStep: () => ({ v1: { assetId: "rev-1", n: 2 } }),
  readFiled: () => ({ variant: "v1", timeline: w.timeline }),
  readDraft: () => ({ timeline: w.timeline, notes: ["Drafted"] }),
  saveDraft: async (...a: unknown[]) => void w.saved.push(a),
}));
vi.mock("../ai-complete", () => ({
  aiFor: () => ({}),
  completeWithFallback: async (_s: string, user: string, _x: unknown, parse: (t: string) => unknown) => (w.asked.push(user), parse(w.answer)),
}));
vi.mock("../ai-vision", () => ({ completeVisionWithFallback: async () => { throw new Error("no pictures in this test"); } }));
vi.mock("../library/jobs", () => ({ enqueueJob: (...a: unknown[]) => void w.queued.push(a.slice(2, 4)) }));
vi.mock("../library/db", () => ({ libraryDb: () => ({}) }));
vi.mock("../library/describe", () => ({ whoFor: (u: string) => ({ username: u, role: "user" }) }));
vi.mock("../library/transcribe", () => ({
  NeedsKey: class extends Error {},
  // the take's words, 10 frames (a third of a second) each
  wordsOf: () => ["we", "teach", "rolls", "um", "and", "cartwheels", "join", "the", "class"].map((w, k) => ({ w, s: k / 3, e: (k + 1) / 3 })),
}));
vi.mock("./script", () => ({ macAway: () => null }));

const { draftView } = await import("./edits");
const { parseAnswers, planRevision, reviseStep, reviseText, zonesOf } = await import("./revise");

/** Three 30-frame shots of one take at 30 fps, each with its voice, and a B-roll clip over the second. */
function cut(): Timeline {
  const tracks = { V1: { name: "Speaker", items: [] as Timeline["tracks"]["V1"]["items"] }, V2: { name: "B-roll", items: [{ src: "ver_b", in: 0, len: 20, rec: 35 }] }, A1: { name: "Voice", items: [] as Timeline["tracks"]["A1"]["items"] }, A2: { name: "Music", items: [] }, A3: { name: "Sound", items: [] } };
  for (const k of [0, 1, 2]) {
    tracks.V1.items.push({ src: "ver_a", in: k * 30, len: 30, rec: k * 30, link: `c${k}` });
    tracks.A1.items.push({ src: "ver_a", in: k * 30, len: 30, rec: k * 30, link: `c${k}` });
  }
  return {
    name: "Tiny v1", fps: 30, width: 1080, height: 1920, tracks, markers: [],
    sources: { ver_a: { versionId: "ver_a", name: "Take", fps: 30, tc: 0, dur: 900, w: 1080, h: 1920 }, ver_b: { versionId: "ver_b", name: "Mat", fps: 30, tc: 0, dur: 300, w: 1080, h: 1920 } },
  };
}
const base = { drawn: false, refs: 0, replies: [], edits: [], anchors: [] };

describe("revise from Review comments", () => {
  it("a comment's zone: the clips it is pinned to, else its moment ± half a second, else none (a general note)", () => {
    expect(zonesOf({ anchors: [{ track: "V1", rec: 30, len: 30, label: "x" }] }, 30)).toEqual([[30, 60]]);
    expect(zonesOf({ anchors: [], t: 1, tEnd: 2 }, 30)).toEqual([[15, 75]]);
    expect(zonesOf({ anchors: [] }, 30)).toBeNull();
  });

  it("reads the AI's answers as Review keeps edits: bad keys, a talent shot's move and an answer with no comment dropped", () => {
    const a = parseAnswers('```json\n{"answers":[{"comment":"c1","reply":"Cut the um.","edits":[{"key":"V1:30","label":"um","split":[39,40]},{"key":"nope"},{"key":"V1:0","move":5}]},{"reply":"no id"}]}\n```');
    expect(a).toEqual([{ comment: "c1", reply: "Cut the um.", edits: [{ key: "V1:30", label: "um", split: [39, 40] }] }]);
    expect(() => parseAnswers("I can't")).toThrow();
  });

  it("changes only what each comment is about, answers every comment, and resolves only the ones it changed", () => {
    const tl = cut();
    const view = draftView(tl);
    const comments = [
      { ...base, id: "c1", t: 1.5, text: "cut the um" },
      { ...base, id: "c2", t: 0.2, text: "use a better take here" },
      { ...base, id: "c3", text: "the B-roll comes in late", anchors: [{ track: "V2", rec: 35, len: 20, label: "Mat" }] },
      { ...base, id: "c4", t: 2.5, text: "tighten the end" },
    ];
    const answers = [
      // the um (frames 30-40 of the cut): split out and removed; a stray edit on the first shot is outside its moment
      { comment: "c1", reply: "Took out the um.", edits: [{ key: "V1:30", label: "um", split: [40], remove: true }, { key: "V1:0", label: "First shot", tail: -5 }] },
      { comment: "c2", reply: "Swap the take in the take list.", edits: [] },
      { comment: "c3", reply: "Brought it in earlier.", edits: [{ key: "V2:35", label: "Mat", move: -5 }] },
      // more footage than the take has: refused whole, stays open
      { comment: "c4", reply: "Trimmed.", edits: [{ key: "V1:60", label: "Third shot", tail: 9000 }] },
    ];
    const plan = planRevision(tl, view, comments, answers);
    expect(plan.replies.map((r) => [r.id, r.resolve])).toEqual([["c1", true], ["c2", false], ["c3", true], ["c4", false]]);
    expect(plan.replies[0]!.reply).toMatch(/Left alone, as the comment isn't about it: First shot\./);
    expect(plan.replies[1]!.reply).toBe("Swap the take in the take list.");
    expect(plan.replies[3]!.reply).toMatch(/^Not done: Third shot: no more footage there\. This stays open\.$/);
    // the first shot untouched, the um gone; the B-roll 5 frames earlier, losing what lay over the um
    expect(plan.timeline!.tracks.V1.items.map((i) => [i.rec, i.len, i.in])).toEqual([[0, 30, 0], [30, 20, 40], [50, 30, 60]]);
    expect(plan.timeline!.tracks.V2.items).toEqual([{ src: "ver_b", in: 10, len: 10, rec: 30 }]);
  });

  it("a word taken out of a shot's middle: split there and the piece removed, everything after moving up", () => {
    const tl = cut();
    const plan = planRevision(tl, draftView(tl), [{ ...base, id: "c1", t: 1.1, text: "cut the um" }], [
      { comment: "c1", reply: "Took out the um.", edits: [{ key: "V1:30", label: "Second shot", split: [35, 40] }, { key: "V1:35", label: "um", remove: true }] },
    ]);
    expect(plan.timeline!.tracks.V1.items.map((i) => [i.rec, i.len, i.in])).toEqual([[0, 30, 0], [30, 5, 30], [35, 20, 40], [55, 30, 60]]);
    expect(plan.timeline!.tracks.V1.items.every((i) => i.link)).toBe(true);
  });

  it("a comment's own timeline edits are made as they are; an AI edit on a clip an earlier comment changed is left out", () => {
    const tl = cut();
    const plan = planRevision(tl, draftView(tl), [
      { ...base, id: "c1", text: "", edits: [{ key: "V2:35", label: "Mat", remove: true }] },
      { ...base, id: "c2", text: "and move the mat later", anchors: [{ track: "V2", rec: 35, len: 20, label: "Mat" }] },
    ], [{ comment: "c2", reply: "Moved it.", edits: [{ key: "V2:35", label: "Mat", move: 10 }] }]);
    expect(plan.timeline!.tracks.V2.items).toEqual([]);
    expect(plan.replies).toEqual([
      { id: "c1", reply: "Made your timeline edits. In the next version.", resolve: true },
      { id: "c2", reply: "Moved it. Kept as an earlier comment changed it: Mat.", resolve: false },
    ]);
  });

  it("the AI is shown each clip with its room, the words with their frames, and each comment with where it sits", () => {
    const tl = cut();
    const text = reviseText(draftView(tl, { ver_a: [{ w: "we", s: 0, e: 0.3 }, { w: "teach", s: 0.3, e: 0.6 }] as never }), [
      { ...base, id: "c1", t: 1.1, text: "cut the um", drawn: true, replies: ["which um?"] },
      { ...base, id: "c2", text: "too long" },
    ]);
    expect(text).toContain("V2:35 frames 35-55 (1.17-1.83 s) Mat (room: 0 frames before, 280 after)");
    expect(text).toContain("Words (word@frame): we@0 teach@9");
    expect(text).toContain("- c1 at 1.10 s (frame 33) [drew on the frame (shown below)]: cut the um\n    reply: which um?");
    expect(text).toContain("- c2 general: too long");
  });

  it("the step: the AI's answer cut in as the draft's next version, post queued, every comment answered", async () => {
    w.timeline = cut();
    w.comments = [
      { id: "c1", version: 2, t: 1.1, text: "cut the um", author: "Tiny", createdAt: 2 },
      { id: "c0", version: 2, text: "lovely", author: "Tiny", createdAt: 1 },
      { id: "r1", version: 2, parentId: "c1", text: "the second one", author: "Tiny", createdAt: 3 },
      { id: "old", version: 1, t: 0, text: "old version", author: "Tiny", createdAt: 0 },
      { id: "done", version: 2, t: 0, text: "fixed", author: "Tiny", createdAt: 0, resolved: true },
    ];
    w.answer = JSON.stringify({ answers: [
      { comment: "c1", reply: "Took out the um.", edits: [{ key: "V1:30", label: "um", split: [40], remove: true }] },
      { comment: "c0", reply: "Thanks!", edits: [] },
    ] });
    await reviseStep({ edit: { id: "e1", workspaceId: "ws" } as never, job: { actor: "maker", version_id: "e1:v1" } as never, variant: "v1", signal: new AbortController().signal });
    expect(w.asked[0]).toMatch(/- c0 general: lovely\n- c1 at 1\.10 s \(frame 33\): cut the um\n {4}reply: the second one/);
    expect(w.asked[0]).not.toContain("old version");
    const [[id, name, saved]] = w.saved as [[string, string, { timeline: Timeline; notes: string[] }]];
    expect([id, name]).toEqual(["e1", "v1"]);
    expect(saved.timeline.tracks.V1.items.map((i) => [i.rec, i.len])).toEqual([[0, 30], [30, 20], [50, 30]]);
    expect(saved.notes).toEqual(["Drafted", "Cut by the AI from 1 Review comment on version 2 (um on V1: taken out with its voice, what follows moves up)"]);
    expect(w.queued).toEqual([["e1:v1", "post"]]);
    expect(w.answered).toEqual([["rev-1", 2, "AI Editor", [
      { id: "c0", reply: "Thanks!", resolve: false },
      { id: "c1", reply: "Took out the um. In the next version.", resolve: true },
    ]]]);
  });
});
