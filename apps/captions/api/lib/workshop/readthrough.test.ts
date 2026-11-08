import { describe, expect, it } from "vitest";
import { readThrough } from "./readthrough";
import { applyEdits, newDocument } from "./doc";
import { buildTurnPrompt } from "./chat-prompt";

const carousel = (...slides: string[]) => {
  const d = newDocument("d1", "s1", "carousel", "Carousel", { text: "x", now: 1 });
  d.blocks = slides.map((text, i) => ({ id: `b${i + 1}`, text, author: "ai" as const, at: 1 }));
  d.nextBlock = slides.length + 1;
  return d;
};

describe("the read-through", () => {
  it("catches the same opening across a slide break (a thread's slides 2 and 3)", () => {
    const notes = readThrough(
      carousel(
        "BUT before your sample can start... the plan has to learn the steps it has\n\nAnd they learn from every step that they take",
        "And they learn it by getting it wrong, hundreds of times",
      ),
    );
    expect(notes).toContain('Two sentences in a row open with "and they" (the end of slide 1 and the start of slide 2).');
  });

  it("catches a phrase said again on another slide, not inside one", () => {
    const notes = readThrough(carousel("They sit on the same bench and seat.", "Later the same bench and seat hold them up.", "Chest, back, side."));
    expect(notes.join(" ")).toContain('"the same bench and"');
    expect(readThrough(carousel("push up through their arms, then push up through their arms again"))).toEqual([]);
  });

  it("measures slides and fragments against the author's posted carousels", () => {
    const his = { slides: Array.from({ length: 10 }, (_, i) => `This is one of my real slides with about twelve words in it, number ${i}`) };
    const wall = Array.from({ length: 60 }, () => "word").join(" ");
    const notes = readThrough(carousel("Short opener that runs on for a while like mine do.", wall, "Fine for the bus. Not the trip. Just let them. Round and round."), his);
    expect(notes.find((n) => n.startsWith("Longer than your posted slides"))).toContain("slide 2 has 60");
    expect(notes.find((n) => n.includes("four words or fewer"))).toContain("in your posted carousels it's 0%");
    expect(readThrough(carousel(wall))).toEqual([]); // no yardstick, no length note
  });
});

describe("locked slides", () => {
  it("refuse the AI's replace and delete, and say which", () => {
    const d = carousel("Mine, approved", "Draft");
    d.locked = ["b1"];
    const r = applyEdits(d, [
      { op: "replace", id: "b1", text: "AI rewrite" },
      { op: "delete", id: "b1" },
      { op: "replace", id: "b2", text: "Better draft" },
      { op: "insert_after", id: "b1", text: "New slide" },
    ]);
    expect(d.blocks.map((b) => b.text)).toEqual(["Mine, approved", "New slide", "Better draft"]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["locked", "locked"]);
  });

  it("show as locked to the writer", () => {
    const d = carousel("Mine, approved", "Draft");
    d.locked = ["b1"];
    const { user, system } = buildTurnPrompt({ frameworks: [], rules: [], doc: d, pinned: [], sources: [], history: [], message: "tighten it" });
    expect(user).toContain("[b1 · ai · locked] Mine, approved");
    expect(user).toContain("[b2 · ai] Draft");
    expect(system).toContain("Blocks marked locked are ones the author approved");
  });
});

describe("the writer keeps every note", () => {
  const history = [
    { id: "m1", role: "user" as const, text: "Slides 1 and 2 are both hooks.", at: 1, docId: "d1" },
    { id: "m2", role: "assistant" as const, text: "Done.", at: 2, docId: "d1" },
    { id: "m3", role: "user" as const, text: "Let sentences run,\nno clipped fragments.", at: 3, docId: "d1" },
  ];

  it("quotes the author's earlier notes right above the new one", () => {
    const { user } = buildTurnPrompt({ frameworks: [], rules: [], doc: carousel("x"), pinned: [], sources: [], history, message: "too much text" });
    const notes = user.indexOf("Everything the author said about this piece before this message");
    expect(notes).toBeGreaterThan(user.indexOf("Conversation so far"));
    expect(notes).toBeLessThan(user.indexOf("Author now: too much text"));
    expect(user).toContain("- Slides 1 and 2 are both hooks.\n- Let sentences run, no clipped fragments.");
  });

  it("asks for their own words only when My words only is on", () => {
    const off = buildTurnPrompt({ frameworks: [], rules: [], doc: carousel("x"), pinned: [], sources: [], history, message: "cut it" });
    const on = buildTurnPrompt({ frameworks: [], rules: [], doc: carousel("x"), pinned: [], sources: [], history, message: "cut it", mine: true });
    expect(off.user).not.toContain("My words only");
    expect(on.user).toContain("My words only: the author wants this built from their own words");
  });
});

describe("the post description", () => {
  it("is kept whole and flagged past Instagram's 2,200, never cut", () => {
    const d = carousel("Slide one");
    const long = "Garrett and colleagues found walker babies crawled about four weeks later. ".repeat(40);
    d.caption = { text: long, author: "ai", at: 1 };
    expect(readThrough(d).find((n) => n.startsWith("The post description is"))).toContain("Instagram cuts captions at 2,200");
    const r = applyEdits(d, [{ op: "set_caption", text: long }]);
    expect(r.blockIds).toContain("caption");
    expect(d.caption?.text.length).toBe(long.trim().length);
  });

  it("is told to back the slides' claims, not recap them", () => {
    const { system } = buildTurnPrompt({ frameworks: [], rules: [], doc: carousel("x"), pinned: [], sources: [], history: [], message: "write the description" });
    expect(system).toContain("the description balances it and cites the sources");
    expect(system).toContain("stops at 2,200 characters");
  });
});

describe("clipped sentences", () => {
  it("are caught two in a row, while a list of arrows or one short line passes", () => {
    const notes = readThrough(carousel("In a chair their back, belly and arms don't hold anything up\n\nFine for the bus. Not the whole trip.", "Chest → back, shoulders, arms\nSide → the muscles down their side\n\nAnd it shows up later."));
    expect(notes).toEqual(['Two clipped sentences in a row on slide 1: "Fine for the bus. Not the whole trip."']);
  });
});

describe("the description against the author's own captions (a 1,969-character sample)", () => {
  const slides = [
    "This is why your schedule needs a clear plan\n\nEven beyond the first month, the second and the third",
    "That learning is mostly them getting it wrong\n\nThey reach for a cup and miss, or lean on one arm and tip over because one side pushed harder",
  ];
  const fable = [
    "When I say plan, I don't mean a schedule.",
    "And they learn it by getting it wrong. Reaching for a cup and missing. Leaning on one arm and tipping over.",
    "They reach for a cup and miss, or lean on one arm and tip over because one side pushed harder, every time.",
    "Ladders. One study found ladder climbers were about 4 weeks slower and about 3 weeks behind. ".repeat(14),
  ].join("\n\n");
  const his = { slides: [], captions: Array.from({ length: 40 }, (_, i) => "x".repeat(200 + i * 30)) };

  it("flags it past the author's captions' length, the recap and the clipped fragments", () => {
    const d = carousel(...slides);
    d.caption = { text: fable, author: "ai", at: 1 };
    const notes = readThrough(d, his);
    expect(notes.find((n) => n.includes("your posted captions run about"))).toContain("9 in 10 are under 1,280");
    expect(notes.some((n) => n.startsWith("Two clipped sentences in a row in the post description"))).toBe(true);
  });

  it("calls a retelling of the slides a recap", () => {
    const d = carousel(...slides);
    d.caption = { text: "They reach for a cup and miss, or lean on one arm and tip over because one side pushed harder. That learning is mostly them getting it wrong.", author: "ai", at: 1 };
    expect(readThrough(d).find((n) => n.includes("repeats the slides' own wording"))).toBeTruthy();
  });

  it("a caption turn reads the author's captions and the last messages only: no scripts of other pieces, no older notes", () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `older turn ${i}`, at: i, docId: "d1" }));
    const { user } = buildTurnPrompt({
      frameworks: [],
      rules: [],
      doc: carousel("the script"),
      pinned: [],
      sources: [],
      history,
      message: "rewrite as a normal Instagram caption like the ones I usually post",
      others: [{ ...carousel("the other piece's script"), title: "Final B" }],
      captionExamples: { examples: [{ text: "A reel caption.", keptPer1k: 40 }], saved: ["Saved on Final B."], median: 300, p90: 900 },
    });
    expect(user).not.toContain("other piece's script");
    expect(user).toContain("Captions the author has saved on the other pieces of this session:\n---\nSaved on Final B.");
    expect(user).toContain("The piece this description is for, in full");
    expect(user).toContain("older turn 29");
    expect(user).not.toContain("older turn 0");
    expect(user).not.toContain("Everything the author said");
    expect(user).toContain("newest reels first");
  });

  it("shows the writer the author's own captions when the author asks for the description", () => {
    const { user } = buildTurnPrompt({
      frameworks: [],
      rules: [],
      doc: carousel("x"),
      pinned: [],
      sources: [],
      history: [],
      message: "Write the post description",
      captionExamples: { examples: [{ text: "Sample review of the app. Very happy, 10/10. Would recommend.", keptPer1k: 92 }], median: 346, p90: 1369 },
    });
    expect(user).toContain("theirs run about 346 characters; 9 in 10 are under 1,369");
    expect(user).toContain("---\nSample review of the app. Very happy, 10/10. Would recommend.\n---");
  });
});
