import { describe, expect, it } from "vitest";
import {
  carouselTypePrompt,
  isCarouselTypeId,
  parseSlideText,
  resolveCarouselType,
  reviewCompare,
  reviewReplace,
  reviewThread,
  visualizeCarousel,
} from "./carousel-visualize";

const b = (id: string, text: string) => ({ id, key: id, text });

describe("parseSlideText", () => {
  it("takes a short first paragraph as the headline", () => {
    const p = parseSlideText("Eyes and hands work together\n\nThe swimmers scored better on visual-motor tasks.");
    expect(p.headline).toBe("Eyes and hands work together");
    expect(p.body).toContain("visual-motor");
    expect(p.hasHeading).toBe(true);
  });

  it("splits on the first line when there is no blank line", () => {
    const p = parseSlideText("The swimmers were ahead in math\nSo the testing also found advantages in early mathematical reasoning.");
    expect(p.headline).toBe("The swimmers were ahead in math");
    expect(p.body.startsWith("So the testing")).toBe(true);
  });

  it("treats a short block as headline only", () => {
    const p = parseSlideText("11 months ahead");
    expect(p).toMatchObject({ headline: "11 months ahead", body: "", hasHeading: true, isShort: true });
  });

  it("flags a long unsplit teaching block as body-only", () => {
    const p = parseSlideText(
      "The average advantage grows for people who begin lessons in the first years of life exactly when their brain is at its most plastic and that is a long sentence.",
    );
    expect(p.hasHeading).toBe(false);
    expect(p.headline).toBe("");
    expect(p.body.length).toBeGreaterThan(90);
  });

  it("keeps a long first paragraph as the headline when a blank line follows", () => {
    const head =
      "People who swim before age five are 6 to 15 months ahead of typical developmental norms -- in reading-related skills, mathematical reasoning, and physical milestones";
    const p = parseSlideText(`${head}\n\nBut the testing also found an advantage somewhere no one expected...`);
    expect(p.headline).toBe(head);
    expect(p.body).toMatch(/^But the testing/);
    expect(p.hasHeading).toBe(true);
  });

  it("treats a long unsplit cover as the headline", () => {
    const head =
      "People who swim before age five are 6 to 15 months ahead of typical developmental norms -- in reading-related skills, mathematical reasoning, and physical milestones";
    const p = parseSlideText(head, "cover");
    expect(p.headline).toBe(head);
    expect(p.body).toBe("");
    expect(p.kicker).toBe("");
  });

  it("maps three blank-line areas on a cover to headline, support, and kicker", () => {
    const p = parseSlideText(
      "People who swim before age five are 6 to 15 months ahead of typical developmental norms\n\nThings like reading-related skills, mathematical reasoning, *and* physical milestones\n\nBut the testing also found an advantage somewhere no one expected...",
      "cover",
    );
    expect(p.areas).toHaveLength(3);
    expect(p.headline).toMatch(/^People who swim/);
    expect(p.body).toMatch(/^Things like/);
    expect(p.body).not.toMatch(/But the testing/);
    expect(p.kicker).toMatch(/^But the testing/);
  });
});

describe("review pass", () => {
  it("splits comparison columns and a trailing question", () => {
    expect(
      reviewCompare(["Sample thing A\n\nblender, swing", "Sample two\n\nempty rug", "Which way, sample reader?"]),
    ).toMatchObject({
      leftTitle: "Sample thing A",
      rightTitle: "Sample two",
      question: "Which way, sample reader?",
    });
  });

  it("keeps said vs instead as a replacement, not a comparison", () => {
    const r = reviewReplace(["Are you okay?", "Your face does the work", "Pause and name what you saw"]);
    expect(r.said).toBe("Are you okay?");
    expect(r.instead).toMatch(/Pause/);
  });

  it("reads them:/you: as the two voices in a thread", () => {
    const m = reviewThread(["them: that counts??", "you: same muscles", "them: so the rug is last??"]);
    expect(m.map((x) => x.from)).toEqual(["them", "you", "them"]);
  });
});

describe("visualizeCarousel", () => {
  const swim = [
    b("b1", "Most families booked lessons so their child would be safe around water"),
    b("b2", "A Merrow study followed thousands of children\n\nThey tested motor skills, language, and early maths — not whether the child could swim."),
    b("b3", "They were months ahead\n\nPeople who had lessons before five were ahead of their peers on motor tasks"),
    b("b4", "Eyes and hands work together\n\nThe swimmers scored better on visual-motor tasks like cutting paper."),
    b("b5", "The swimmers were ahead in math\n\nThe testing found advantages in early mathematical reasoning without extra counting."),
    b("b6", "Earlier start gives a bigger shift\n\nThe average advantage grows for people who begin in the first years of life."),
    b("b7", "For a child under five years old...\n\nOne weekly swimming lesson is the most demanding full-body coordination task at that age."),
    b("b8", "Movement of all kinds is what a young brain demands\n\nFollow @tinyacrobatics for what the research actually says"),
  ];

  it("does not flag a long cover headline that has a kicker", () => {
    const m = visualizeCarousel({
      typeId: "explainer",
      blocks: [
        b(
          "b1",
          "People who swim before age five are 6 to 15 months ahead of typical developmental norms -- in reading-related skills, mathematical reasoning, and physical milestones\n\nBut the testing also found an advantage somewhere no one expected...",
        ),
        b("b2", "What they tested\n\nVisual-motor tasks, language, and early maths."),
        b("b3", "Follow @coach"),
      ],
      caption: "x",
    });
    expect(m.slides[0]!.parsed.headline).toMatch(/^People who swim/);
    expect(m.slides[0]!.parsed.kicker).toMatch(/^But the testing/);
    expect(m.slides[0]!.missing).toEqual([]);
    expect(m.gaps.some((g) => g.text.includes("Slide 1"))).toBe(false);
  });

  it("maps an explainer as cover, connected middles, takeaway", () => {
    const m = visualizeCarousel({ typeId: "explainer", blocks: swim, caption: "extra finding" });
    expect(m.slides.map((s) => s.layout)).toEqual([
      "cover",
      "teaching",
      "teaching",
      "teaching",
      "teaching",
      "teaching",
      "teaching",
      "closer",
    ]);
    expect(m.slides.map((s) => s.role)).toEqual([
      "cover",
      "explain",
      "example",
      "consequence",
      "change",
      "explain",
      "example",
      "close",
    ]);
    expect(m.slides[3]!.parsed.headline).toBe("Eyes and hands work together");
    expect(m.gaps).toEqual([]);
    expect(m.slides.map((s) => s.well)).toEqual([
      undefined,
      "banner",
      "square",
      "tall",
      "strip",
      "banner",
      "square",
      undefined,
    ]);
  });

  it("uses two-column choice slides vs replacement slides, with different well sizes", () => {
    const blocks = [
      b("b1", "Which way?"),
      b("b2", "Sample thing A\n\nblender\n\nSample two\n\nrug\n\nWhich way, sample reader?"),
      b("b3", "The common thread"),
    ];
    const compare = visualizeCarousel({ typeId: "compare", blocks, caption: "x" });
    const replace = visualizeCarousel({
      typeId: "replace",
      blocks: [
        b("b1", "Seven phrases"),
        b("b2", "Are you okay?\n\nYour face does the work\n\nPause and name what you saw"),
        b("b3", "Get specific"),
      ],
      caption: "x",
    });
    expect(compare.slides.map((s) => s.layout)).toEqual(["cover", "twoCol", "closer"]);
    expect(replace.slides.map((s) => s.layout)).toEqual(["cover", "replace", "closer"]);
    expect(compare.slides[1]!.well).toBe("pair");
    expect(replace.slides[1]!.well).toBe("pair");
    expect(replace.slides[1]!.parsed.instead).toMatch(/Pause/);
  });

  it("flags too few slides without demanding a sales closer", () => {
    const m = visualizeCarousel({ typeId: "explainer", blocks: [b("b1", "A hook")] });
    expect(m.slides.map((s) => [s.role, s.ghost])).toEqual([
      ["cover", false],
      ["explain", true],
      ["close", true],
    ]);
    expect(m.gaps.map((g) => g.id)).toEqual(["too-few", "no-body", "caption"]);
  });

  it("treats a myth as a headline plus correction, not a truth box", () => {
    const m = visualizeCarousel({
      typeId: "myths",
      blocks: [
        b("b1", "Eight myths"),
        b("b2", "Myth 8\n\nThis is just forcing milestones\n\nGuided movement is laying the foundation."),
        b("b3", "Who is doing the movement"),
      ],
      caption: "x",
    });
    expect(m.slides[1]!.layout).toBe("myth");
    expect(m.slides[1]!.parsed.label).toBe("Myth 8");
    expect(m.slides[1]!.parsed.headline).toMatch(/forcing milestones/);
    expect(m.slides[1]!.well).toBe("banner");
    expect(m.slides[1]!.missing).toEqual([]);
  });

  it("keeps one case per slide instead of pairing a footage card", () => {
    const m = visualizeCarousel({
      typeId: "cases",
      blocks: [
        b("b1", "Puppies hung out of windows"),
        b("b2", "London, 1920s\n\nPuppies hung outside windows for fresh air\n\nDoctors prescribed sunlight."),
        b("b3", "the window cage"),
        b("b4", "What the cases share"),
      ],
      caption: "x",
    });
    expect(m.slides.map((s) => s.role)).toEqual(["cover", "case", "case", "close"]);
    expect(m.slides.map((s) => s.layout)).toEqual(["cover", "case", "case", "closer"]);
    expect(m.slides[1]!.well).toBe("banner");
    expect(m.slides[2]!.well).toBe("square");
  });

  it("treats a stored tally type as an explainer, not a running-number card", () => {
    const m = visualizeCarousel({
      typeId: "tally",
      blocks: [
        b("b1", "I added up the minutes"),
        b("b2", "480 minutes awake\n\nStarting the day"),
        b("b3", "Nursing takes a hundred"),
        b("b4", "What is left is the day"),
      ],
      caption: "x",
    });
    expect(m.type.id).toBe("explainer");
    expect(m.slides.every((s) => s.layout !== "thread" || s.role === "message")).toBe(true);
    expect(m.slides.map((s) => s.layout)).toEqual(["cover", "teaching", "teaching", "closer"]);
    expect(m.gaps.some((g) => g.id.startsWith("math:"))).toBe(false);
  });

  it("does not demand a headline on a conversation slide", () => {
    const m = visualizeCarousel({
      typeId: "conversation",
      blocks: [
        b("b1", "them: she screams the second I put her down\n\nyou: lie back on the couch"),
        b("b2", "them: that counts??\n\nyou: same muscles"),
        b("b3", "them: so the rug is last??"),
      ],
      caption: "x",
    });
    expect(m.slides.every((s) => s.layout === "thread")).toBe(true);
    expect(m.slides.every((s) => s.missing.length === 0)).toBe(true);
    expect(m.slides.every((s) => s.well == null)).toBe(true);
  });

  it("still understands old type ids", () => {
    const m = visualizeCarousel({ typeId: "insight", blocks: swim, caption: "x" });
    expect(m.type.id).toBe("explainer");
  });
});

describe("carousel types", () => {
  it("resolves unknown ids to explainer and only prompts when a type is set", () => {
    expect(isCarouselTypeId("explainer")).toBe(true);
    expect(isCarouselTypeId("insight")).toBe(true);
    expect(isCarouselTypeId("poem")).toBe(false);
    expect(resolveCarouselType("nope").id).toBe("explainer");
    expect(carouselTypePrompt("explainer")).toContain("Carousel type (Explainer)");
    expect(carouselTypePrompt(undefined)).toBeNull();
  });
});

describe("compose overrides", () => {
  it("keeps a two-column middle on an explainer when the copy has two sides", () => {
    const m = visualizeCarousel({
      typeId: "explainer",
      blocks: [b("b1", "The claim"), b("b2", "Container\n\nblender\n\nFloor\n\nrug"), b("b3", "What to change")],
      caption: "x",
      compose: [
        { layout: "cover", well: "none" },
        { layout: "twoCol", well: "banner" },
        { layout: "closer", well: "none" },
      ],
    });
    expect(m.slides.map((s) => [s.ghost, s.layout, s.well])).toEqual([
      [false, "cover", undefined],
      [false, "twoCol", "banner"],
      [false, "closer", undefined],
    ]);
  });

  it("refuses a layout that is not in the type's kit", () => {
    const explainer = visualizeCarousel({
      typeId: "explainer",
      blocks: [b("b1", "The claim"), b("b2", "Why it happens"), b("b3", "What to change")],
      caption: "x",
      compose: [
        { layout: "myth", well: "square" },
        { layout: "thread", well: "strip" },
        { layout: "replace", well: "pair" },
      ],
    });
    expect(explainer.slides.map((s) => s.layout)).toEqual(["cover", "teaching", "closer"]);

    const talk = visualizeCarousel({
      typeId: "conversation",
      blocks: [
        b("b1", "them: she screams\n\nyou: lie back"),
        b("b2", "them: that counts??"),
        b("b3", "them: so the rug is last??"),
      ],
      caption: "x",
      compose: [
        { layout: "cover", well: "banner" },
        { layout: "teaching", well: "tall" },
        { layout: "closer", well: "strip" },
      ],
    });
    expect(talk.slides.every((s) => s.layout === "thread")).toBe(true);
    expect(talk.slides[2]!.well).toBe("strip");
  });
});
