import { describe, expect, it } from "vitest";
import { checkSpeechWords, promptOf, speechCorrector, termsOf } from "./speech-words";

describe("the words the speech engines listen for", () => {
  it("trims and keeps the spelling, and drops a sounds-like that is the term itself", () => {
    expect(checkSpeechWords([{ term: "  Tiny   Acrobatics ", soundsLike: [" tiny acro ", "Tiny Acrobatics"] }])).toEqual([
      { term: "Tiny Acrobatics", soundsLike: ["tiny acro"] },
    ]);
  });

  it("refuses what the limits or the uniqueness rule forbid, with the reason", () => {
    expect(checkSpeechWords("x")).toMatch(/list/);
    expect(checkSpeechWords([{ term: "  ", soundsLike: [] }])).toMatch(/needs a term/);
    expect(checkSpeechWords([{ term: "a".repeat(51), soundsLike: [] }])).toMatch(/needs a term/);
    expect(checkSpeechWords([{ term: "Tiny", soundsLike: Array(9).fill("x") }])).toMatch(/at most 8/);
    expect(checkSpeechWords([{ term: "Tiny", soundsLike: ["tony"] }, { term: "Tony", soundsLike: [] }])).toMatch(/listed twice/);
    expect(checkSpeechWords(Array.from({ length: 101 }, (_, i) => ({ term: `w${i}`, soundsLike: [] })))).toMatch(/At most 100/);
  });

  it("gives the engines the terms, and the OpenAI prompt is cut to fit", () => {
    const words = checkSpeechWords([{ term: "Tiny", soundsLike: ["tony"] }, { term: "Pilates", soundsLike: [] }]) as { term: string; soundsLike: string[] }[];
    expect(termsOf(words)).toEqual(["Tiny", "Pilates"]);
    expect(promptOf(["x".repeat(900)])).toHaveLength(800);
  });

  it("rewrites each sounds-like spelling to its term, whole words only, ignoring case", () => {
    const fix = speechCorrector([{ term: "Tiny Acrobatics", soundsLike: ["tiny acro", "tinyacro"] }, { term: "Tiny", soundsLike: ["tony"] }]);
    expect(fix("Come to Tiny Acro, Tony.")).toBe("Come to Tiny Acrobatics, Tiny.");
    expect(fix("TINY ACRO!")).toBe("Tiny Acrobatics!");
    // inside another word, nothing changes
    expect(fix("tonyship and Tonys")).toBe("tonyship and Tonys");
    // a text with no spelling of the person's is left as it is
    expect(speechCorrector(undefined)("unchanged")).toBe("unchanged");
  });
});
