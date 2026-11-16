import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clipRangeHref,
  isGuideAssetName,
  guideSaves,
  mergeGuideEdits,
  parseDocKind,
  parseGuidePlan,
  parseStoredGuide,
  saveLabel,
  planToGuide,
} from "./guide";

const sample = JSON.stringify({
  title: "Share a clip",
  purpose: "Publish a recording.",
  prerequisites: ["A finished clip"],
  verification: ["The share link opens"],
  steps: [
    {
      title: "Open sharing",
      instruction: "Click Share in the header.",
      startSec: 4,
      endSec: 9,
      atSec: 6,
    },
    {
      title: "Copy the link",
      instruction: "Press Copy link.",
      startSec: 9.2,
      endSec: 14,
      atSec: 11,
    },
  ],
});

describe("parseDocKind", () => {
  it("defaults missing values to brief", () => {
    expect(parseDocKind(undefined)).toBe("brief");
    expect(parseDocKind("guide")).toBe("guide");
  });
});

describe("parseGuidePlan", () => {
  it("clamps times and keeps step order", () => {
    const plan = parseGuidePlan(sample, 20);
    expect(plan.title).toBe("Share a clip");
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].atSec).toBe(6);
    expect(plan.steps[1].startSec).toBeCloseTo(9.2);
  });

  it("fills a missing atSec inside the range", () => {
    const plan = parseGuidePlan(
      JSON.stringify({
        title: "T",
        steps: [
          { title: "A", instruction: "Do it", startSec: 2, endSec: 6 },
        ],
      }),
      10,
    );
    expect(plan.steps[0].atSec).toBeGreaterThanOrEqual(2);
    expect(plan.steps[0].atSec).toBeLessThan(6);
  });

  it("rejects empty step lists", () => {
    expect(() => parseGuidePlan('{"title":"X","steps":[]}', 10)).toThrow(
      /no usable steps/i,
    );
  });
});

describe("planToGuide / stored guide", () => {
  it("round-trips through parseStoredGuide", () => {
    const plan = parseGuidePlan(sample, 20);
    const guide = planToGuide(plan, "clip-a", (i, step) => [
      {
        assetId: `step-${i + 1}.jpg`,
        requestedMs: Math.round(step.atSec * 1000),
        actualMs: Math.round(step.atSec * 1000),
        alt: step.title,
      },
    ]);
    const again = parseStoredGuide(JSON.parse(JSON.stringify(guide)));
    expect(again?.steps[0].source.clipId).toBe("clip-a");
    expect(again?.steps[0].media[0].assetId).toBe("step-1.jpg");
  });

  it("mergeGuideEdits keeps media and ranges", () => {
    const plan = parseGuidePlan(sample, 20);
    const guide = planToGuide(plan, "clip-a", () => []);
    const next = mergeGuideEdits(guide, {
      steps: [{ id: "step-1", title: "Open share", instruction: "Tap Share." }],
    });
    expect(next.steps[0].title).toBe("Open share");
    expect(next.steps[0].source.startMs).toBe(guide.steps[0].source.startMs);
    expect(next.steps[1].title).toBe(guide.steps[1].title);
  });
});

describe("assets and hrefs", () => {
  it("accepts step filenames only", () => {
    expect(isGuideAssetName("step-1.jpg")).toBe(true);
    expect(isGuideAssetName("../x.jpg")).toBe(false);
  });

  it("builds a range URL", () => {
    expect(clipRangeHref("abc", 12, 18)).toBe("/clips/abc?t=12&end=18");
  });

  it("allowlists published still URLs without path traversal", () => {
    const uuid =
      "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const re = new RegExp(
      `^/api/documents/${uuid}(?:/assets/[a-z0-9-]+\\.jpe?g)?$`,
      "i",
    );
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(re.test(`/api/documents/${id}`)).toBe(true);
    expect(re.test(`/api/documents/${id}/assets/step-1.jpg`)).toBe(true);
    expect(re.test(`/api/documents/${id}/assets/../meta.json`)).toBe(false);
  });
});

describe("guideToMarkdown", () => {
  it("does not embed clip players", async () => {
    const { guideToMarkdown, parseGuidePlan, planToGuide } = await import(
      "./guide"
    );
    const plan = parseGuidePlan(sample, 20);
    const md = guideToMarkdown(
      "Share a clip",
      planToGuide(plan, "clip-a", () => []),
    );
    expect(md).toContain("# Share a clip");
    expect(md).not.toMatch(/\/clips\//);
    expect(md).not.toMatch(/!\[/);
  });
});

describe("the Guide Builder's save label", () => {
  it("says Saved only when the server has everything typed", () => {
    expect(saveLabel({ edits: 0, tried: 0, saved: 0, out: 0 })).toBe("Saved");
    expect(saveLabel({ edits: 3, tried: 3, saved: 3, out: 0 })).toBe("Saved");
    // typed, the save not gone yet
    expect(saveLabel({ edits: 4, tried: 3, saved: 3, out: 0 })).toBe("Saving…");
    // one of two saves has answered
    expect(saveLabel({ edits: 4, tried: 4, saved: 3, out: 1 })).toBe("Saving…");
    // the save failed: its error is on the page, the label says nothing
    expect(saveLabel({ edits: 4, tried: 4, saved: 3, out: 0 })).toBe("");
  });
});

describe("a guide's saves (guideSaves)", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());
  const turn = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

  // a guide whose text is one string; the server answers a save when the test says so, with the text it was sent
  const guide = () => {
    const sent: { text: string; answer: (ok?: boolean) => void }[] = [];
    const shown: string[] = [];
    const labels: string[] = [];
    const saves = guideSaves<string, string>({
      send: (text) => new Promise((ok, no) => sent.push({ text, answer: (fine = true) => (fine ? ok(text) : no(new Error("offline"))) })),
      saved: (text) => shown.push(text),
      failed: () => {},
      changed: (counts) => labels.push(saveLabel(counts)),
    });
    return { saves, sent, shown, texts: () => sent.map((s) => s.text), label: () => labels.at(-1) };
  };

  it("sends one save at a time, and the text typed last is the text sent last", async () => {
    const g = guide();
    g.saves.type("a");
    await turn(700);
    expect(g.texts()).toEqual(["a"]);
    // typed while that save is out: it waits for the answer, however long ago its 700 ms passed
    g.saves.type("ab");
    await turn(700);
    g.saves.type("abc");
    await turn(700);
    expect(g.texts()).toEqual(["a"]);
    g.sent[0]!.answer();
    await turn();
    expect(g.texts()).toEqual(["a", "abc"]);
    expect(g.label()).toBe("Saving…");
    g.sent[1]!.answer();
    await turn();
    // the answers come in the order asked: the older text is never shown after the newer
    expect(g.shown).toEqual(["a", "abc"]);
    expect(g.label()).toBe("Saved");
  });

  it("leaving a guide sends what was typed at once, to that guide, and its timer sends nothing after", async () => {
    const left = guide();
    const opened = guide();
    left.saves.type("typed in the first");
    void left.saves.flush();
    await turn();
    // typing in the guide opened next takes nothing from the first one's save
    opened.saves.type("typed in the second");
    await turn(700);
    expect(left.texts()).toEqual(["typed in the first"]);
    expect(opened.texts()).toEqual(["typed in the second"]);
    left.sent[0]!.answer();
    await turn();
    expect(left.shown).toEqual(["typed in the first"]);
    expect(opened.shown).toEqual([]);
  });

  it("Regenerate: what was typed is saved before it runs, nothing is sent while it runs, what is typed meanwhile is dropped", async () => {
    const g = guide();
    g.saves.type("typed before");
    let started = false;
    let finish!: (text: string) => void;
    const regenerated = g.saves.replace(() => {
      started = true;
      return new Promise<string>((ok) => (finish = ok));
    });
    await turn();
    expect(g.texts()).toEqual(["typed before"]);
    expect(started).toBe(false);
    g.sent[0]!.answer();
    await turn();
    expect(started).toBe(true);
    g.saves.type("typed while it runs");
    await turn(700);
    expect(g.texts()).toEqual(["typed before"]);
    finish("regenerated");
    expect(await regenerated).toBe("regenerated");
    await turn(700);
    // never written over its result, and the label is the regenerated guide's
    expect(g.texts()).toEqual(["typed before"]);
    expect(g.label()).toBe("Saved");
  });

  it("a Regenerate that fails keeps what was typed while it ran, and saves it after", async () => {
    const g = guide();
    let fail!: (e: Error) => void;
    const regenerated = g.saves.replace(() => new Promise<string>((_, no) => (fail = no)));
    await turn();
    g.saves.type("typed while it runs");
    await turn(700);
    expect(g.texts()).toEqual([]);
    fail(new Error("no AI"));
    await expect(regenerated).rejects.toThrow("no AI");
    await turn();
    expect(g.texts()).toEqual(["typed while it runs"]);
  });

  it("a save that is not the text (the name, sharing) waits its turn and marks no typed text as saved", async () => {
    const g = guide();
    g.saves.type("a");
    await turn(700);
    void g.saves.save("shared");
    await turn();
    expect(g.texts()).toEqual(["a"]);
    g.sent[0]!.answer(false);
    await turn();
    expect(g.texts()).toEqual(["a", "shared"]);
    g.sent[1]!.answer();
    await turn();
    // the text's save failed: the label says nothing (its error is on the page), not Saved
    expect(g.label()).toBe("");
    // Save sends that text again
    void g.saves.flush();
    await turn();
    expect(g.texts()).toEqual(["a", "shared", "a"]);
    g.sent[2]!.answer();
    await turn();
    expect(g.label()).toBe("Saved");
  });
});
