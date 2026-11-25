import { describe, expect, it } from "vitest";
import { KEEP_PRIVATE } from "../../lib/workshop/prompt";
import { lookPrompt, makePrompt, parsePlan, planPrompt, type FrameInput } from "./prompts";

const lines = [
  { n: 1, text: "Here is the thing about rolling.", ok: true, seconds: 1.2 }, // 3 words
  { n: 2, text: "First, tuck your chin all the way.", ok: true, seconds: 2.4 }, // 7 words
  { n: 3, text: "Follow for the next one.", ok: false, seconds: 0 },
];

describe("the card plan", () => {
  it("shows each line's word budget and asks for nothing private", () => {
    const { system, user } = planPrompt({ lines, brief: "" });
    expect(user).toContain("1* (3 words at most) Here is");
    expect(user).toContain("2* (7 words at most) First,");
    expect(user).toContain("\n3 Follow for");
    expect(system).toContain(KEEP_PRIVATE);
  });

  it("refuses a card longer than its line's budget, as it refuses a line with no room", () => {
    const picked = parsePlan(JSON.stringify({ cards: [{ line: 1, text: "Tuck your chin in" }, { line: 2, text: "Tuck your chin all the way in" }, { line: 3, text: "Follow" }] }), lines);
    expect(picked).toEqual([{ line: 2, text: "Tuck your chin all the way in" }]);
    expect(parsePlan(JSON.stringify({ cards: [{ line: 1, text: "Tuck your chin" }] }), lines)).toEqual([{ line: 1, text: "Tuck your chin" }]);
  });
});

describe("the stage", () => {
  const frame = (width: number, height: number): FrameInput => ({ brief: "", width, height, fps: 30, cards: [] });
  const band = "Words stay between y 269 and 1248 and left of x 929; the rest is under the reel's buttons and caption.";

  it("a vertical video gets the reel band in CSS pixels, and the look counts words under the buttons as broken", () => {
    expect(makePrompt({ ...frame(1080, 1920), made: 0, inspirations: 0 }).system).toContain(band);
    const look = lookPrompt({ ...frame(1080, 1920), script: "", columns: true, pictures: 0 }).system;
    expect(look).toContain(band);
    expect(look).toContain("words under the reel's buttons");
  });

  it("a landscape or 4:5 video gets neither", () => {
    for (const [w, h] of [[1920, 1080], [1080, 1350]] as const) {
      expect(makePrompt({ ...frame(w, h), made: 0, inspirations: 0 }).system).not.toContain("Words stay between");
      expect(lookPrompt({ ...frame(w, h), script: "", columns: true, pictures: 0 }).system).not.toContain("reel's buttons");
    }
  });
});
