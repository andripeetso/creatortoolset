import { describe, expect, it } from "vitest";
import {
  buildLayoutPrompt,
  coerceCompose,
  compactSlideLine,
  layoutSourceHash,
  liveCompose,
  parseCarouselLayoutSet,
  parseLayoutVariants,
  parseOneCompose,
} from "./carousel-layout";

const fallback = [
  { layout: "cover" as const, well: "none" as const },
  { layout: "teaching" as const, well: "banner" as const },
  { layout: "closer" as const, well: "none" as const },
];

describe("layoutSourceHash", () => {
  it("is stable for the same type and copy, and changes when either does", () => {
    const a = layoutSourceHash("explainer", ["Hello", "Body"]);
    expect(layoutSourceHash("explainer", ["Hello", "Body"])).toBe(a);
    expect(layoutSourceHash("compare", ["Hello", "Body"])).not.toBe(a);
    expect(layoutSourceHash("explainer", ["Hello", "Other"])).not.toBe(a);
  });
});

describe("compactSlideLine", () => {
  it("truncates areas so the prompt stays small", () => {
    const long = "x".repeat(400);
    const line = compactSlideLine(2, `${long}\n\n${long}\n\n${long}\n\n${long}\n\n${long}`);
    expect(line.startsWith("2|")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(280);
    expect(line).not.toContain("x".repeat(121));
  });
});

describe("parse compose", () => {
  it("fills missing picks from the deterministic fallback and clamps to the type kit", () => {
    expect(coerceCompose(["cover", "nope"], 3, fallback, "explainer")).toEqual([
      { layout: "cover", well: "none" },
      { layout: "teaching", well: "banner" },
      { layout: "closer", well: "none" },
    ]);
    expect(coerceCompose([["cover", "none"], ["myth", "square"], ["closer", "none"]], 3, fallback, "explainer")).toEqual([
      { layout: "cover", well: "none" },
      { layout: "teaching", well: "square" },
      { layout: "closer", well: "none" },
    ]);
  });

  it("reads two variants and drops a duplicate", () => {
    const v = parseLayoutVariants(
      '```json\n{"v":[[["cover","none"],["twoCol","banner"],["closer","none"]],[["cover","none"],["twoCol","banner"],["closer","none"]],[["cover","none"],["teaching","tall"],["closer","none"]]]}\n```',
      3,
      fallback,
      "explainer",
    );
    expect(v).toEqual([
      [
        { layout: "cover", well: "none" },
        { layout: "twoCol", well: "banner" },
        { layout: "closer", well: "none" },
      ],
      [
        { layout: "cover", well: "none" },
        { layout: "teaching", well: "tall" },
        { layout: "closer", well: "none" },
      ],
    ]);
  });

  it("reads a single-slide pick and keeps conversation as a thread", () => {
    expect(parseOneCompose('{"layout":"twoCol","well":"banner"}', fallback[1]!, "explainer", 3, 1)).toEqual({
      layout: "twoCol",
      well: "banner",
    });
    expect(parseOneCompose('{"layout":"myth"}', fallback[1]!, "explainer", 3, 1)).toEqual({
      layout: "teaching",
      well: "banner",
    });
    expect(parseOneCompose('{"layout":"teaching","well":"tall"}', { layout: "thread", well: "none" }, "conversation", 3, 1)).toEqual({
      layout: "thread",
      well: "none",
    });
  });

  it("rejects a stored set whose hash is gone and still reads old string rows", () => {
    const set = parseCarouselLayoutSet({
      hash: "deadbeef",
      pick: 1,
      variants: [
        ["cover", "teaching", "closer"],
        [
          ["cover", "none"],
          ["twoCol", "pair"],
          ["closer", "none"],
        ],
      ],
    });
    expect(set?.pick).toBe(1);
    expect(liveCompose(set, "cafebabe", 3)).toBeUndefined();
    expect(liveCompose(set, "deadbeef", 3)).toEqual([
      { layout: "cover", well: "none" },
      { layout: "twoCol", well: "pair" },
      { layout: "closer", well: "none" },
    ]);
  });
});

describe("buildLayoutPrompt", () => {
  it("sends the allowed kit, truncated areas, and shape names — not the full copy", () => {
    const body = "y".repeat(500);
    const { system, user } = buildLayoutPrompt({
      typeId: "compare",
      shapes: ["Open loop", "Proof"],
      slides: [{ text: `Headline\n\n${body}` }, { text: "Takeaway" }],
    });
    expect(system).toContain("twoCol:");
    expect(system).toContain("JSON only");
    expect(system).toContain("Two columns only when the slide has two sides");
    expect(system).toContain("Conversation stays a thread");
    expect(system).toContain("mid twoCol/");
    expect(system).not.toContain("footage");
    expect(system).not.toContain("tally");
    expect(user).toContain("type: compare");
    expect(user).toContain("shapes: Open loop, Proof");
    expect(user).not.toContain(body);
    expect(user.length).toBeLessThan(800);
  });

  it("for one slide, sends the current pairing and only that slide's areas", () => {
    const { user } = buildLayoutPrompt({
      typeId: "explainer",
      slides: [{ text: "A" }, { text: "B" }, { text: "C" }],
      slide: 2,
      current: [
        { layout: "cover", well: "none" },
        { layout: "teaching", well: "banner" },
        { layout: "closer", well: "none" },
      ],
    });
    expect(user).toContain("now:1:cover/none 2:teaching/banner 3:closer/none");
    expect(user).toContain("redo 2");
    expect(user).toContain("2|B");
    expect(user).not.toContain("1|A");
  });
});
