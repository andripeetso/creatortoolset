import { describe, expect, it } from "vitest";
import { NOTES_MAX, buildGeneratePrompt, matchKnowledge, renderAccountContext } from "./prompt";

const base = {
  project: { name: "Tiny Acrobatics", audience: "parents", voice: "warm", cta: "save it", notes: "" },
  frameworks: [{ name: "PAS", role: "persuasion" as const, summary: "problem first", steps: ["Problem", "Agitate", "Solve"], whenToUse: "pain", example: undefined }],
  notes: "comments love the pool angle",
  prompt: "make it about pools",
  packs: [{ handle: "coach", kind: "reel", url: "https://x/1", markdown: "# @coach\nbody", note: "use the hook" }],
};

describe("buildGeneratePrompt", () => {
  it("orders the blocks and includes the kind's JSON shape", () => {
    const { system, user } = buildGeneratePrompt({ kind: "reel", ...base });
    const order = ["Project: Tiny Acrobatics", "PAS — problem first", "1. Problem", "Session notes", "Brief:\nmake it about pools", "Deliverable: A reel script", "Source 1 of 1: @coach — reel — https://x/1", "How to use this source: use the hook", "# @coach"];
    let at = -1;
    for (const needle of order) {
      const next = user.indexOf(needle, at + 1);
      expect(next, needle).toBeGreaterThan(at);
      at = next;
    }
    expect(system).toContain('"beats"');
    expect(system).toContain("one JSON object");
    expect(system).toContain("Sources kept for format are layout examples");
    expect(system).not.toContain("Write like you talk");
    expect(system).toContain("make that structure visible");
    expect(system).not.toContain("the way a person talks");
    expect(system).not.toContain("The steps are the skeleton");
    expect(system).not.toContain("senior short-form content writer");
    expect(system).not.toContain("Short sentences");
  });

  it("lists the rules before the notes", () => {
    const { user } = buildGeneratePrompt({ kind: "reel", ...base, rules: ["No and then.", "Payoff last."] });
    expect(user).toContain("Rules for this piece (they always apply):\n- No and then.\n- Payoff last.");
    expect(user.indexOf("Rules for this piece")).toBeLessThan(user.indexOf("Session notes"));
  });

  it("combines several frameworks with an instruction", () => {
    const { user } = buildGeneratePrompt({
      kind: "reel",
      packs: [],
      notes: "",
      prompt: "x",
      frameworks: [
        { name: "PAS", role: "persuasion" as const, summary: "", steps: ["P", "A", "S"], whenToUse: "", example: undefined },
        { name: "Pixar", role: "narrative" as const, summary: "", steps: ["Once", "Every day"], whenToUse: "", example: undefined },
      ],
    });
    expect(user).toContain("Frameworks to combine (2)");
    // the narrative shape is listed first whatever order it was given in
    expect(user.indexOf("Pixar")).toBeLessThan(user.indexOf("PAS"));
    expect(user).toContain("narrative shape — sets the order");
    expect(user).toContain("make the structure visible");
  });

  it("tells the model a format source is layout only", () => {
    const { user } = buildGeneratePrompt({
      kind: "reel",
      packs: [{ handle: "coach", kind: "reel", url: "https://x/1", markdown: "body", savedFor: ["format"] }],
      notes: "",
      prompt: "x",
    });
    expect(user).toContain("Kept for format only");
    expect(user).toContain("Do not use its topic");
  });

  it("treats unmarked sources as content", () => {
    const { user } = buildGeneratePrompt({ kind: "reel", ...base });
    expect(user).toContain("Kept for content — facts, angles");
  });

  it("leaves out empty blocks and clamps notes", () => {
    const { user } = buildGeneratePrompt({ kind: "ad", packs: [], notes: "x".repeat(NOTES_MAX + 50), prompt: "" });
    expect(user).not.toContain("Project:");
    expect(user).not.toContain("Framework:");
    expect(user).not.toContain("Brief:");
    expect(user).toContain("Deliverable: Ad copy");
    expect(user.length).toBeLessThan(NOTES_MAX + 200);
  });

  it("lists context files instead of dumping them", () => {
    const { user } = buildGeneratePrompt({
      kind: "reel",
      ...base,
      project: {
        ...base.project,
        notes: "never medical",
        knowledge: [{ id: "file-1", name: "voice.md", text: "We never say exercise.", addedAt: 1 }],
      },
    });
    expect(user).toContain("Instructions:\nnever medical");
    expect(user).toContain("K1 voice.md");
    expect(user).toContain("We never say exercise.");
    expect(user).toContain("Context files (not loaded");
    expect(user).toContain("Context excerpts");
    expect(user.indexOf("Context files")).toBeLessThan(user.indexOf("PAS — problem first"));
  });

  it("keeps a huge context file to a short excerpt", () => {
    const { user } = buildGeneratePrompt({
      kind: "free",
      packs: [],
      notes: "",
      prompt: "",
      project: {
        name: "X",
        audience: "",
        voice: "",
        cta: "",
        notes: "",
        knowledge: [{ id: "file-1", name: "big.md", text: "x".repeat(30_000), addedAt: 1 }],
      },
    });
    expect(user).toContain("K1 big.md");
    expect(user).toContain("…[shortened]");
    expect(user).not.toContain("x".repeat(9000));
  });

  it("caps always-on instructions", () => {
    const { user } = buildGeneratePrompt({
      kind: "free",
      packs: [],
      notes: "",
      prompt: "",
      project: { name: "X", audience: "", voice: "", cta: "", notes: "n".repeat(25_000), knowledge: [] },
    });
    expect(user).toContain("Instructions:");
    expect(user).toContain("n".repeat(5000)); // the author's instructions are whole up to 20,000 (an older limit of 1,800 cut them)
    expect(user).toContain("…[shortened]");
    expect(user).not.toContain("n".repeat(21_000));
  });

  it("resolves K1 and file names", () => {
    const files = [
      { id: "file-1", name: "voice.md", text: "a", addedAt: 1 },
      { id: "file-2", name: "offer.md", text: "b", addedAt: 1 },
    ];
    expect(matchKnowledge(files, "K2")?.name).toBe("offer.md");
    expect(matchKnowledge(files, "voice.md")?.id).toBe("file-1");
  });
});

describe("renderAccountContext", () => {
  it("names the handle and says the posts are theirs", () => {
    const text = renderAccountContext({
      id: "a1",
      username: "tinyacrobatics",
      followers: 100,
      biography: "pools",
      fetchedAt: Date.UTC(2026, 8, 1),
    });
    expect(text).toContain("@tinyacrobatics");
    expect(text).toContain("100 followers");
    expect(text).toContain("Bio: pools");
    expect(text).toContain("their scripts");
  });
});
