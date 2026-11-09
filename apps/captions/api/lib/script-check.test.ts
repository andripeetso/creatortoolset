import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai-complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ai-complete")>()),
  completeWithFallback: vi.fn(),
}));

import { completeWithFallback } from "../ai-complete";
import {
  parseScriptEdits,
  scriptCheckPrompt,
  scriptEdits,
  soundsAlike,
  vetScriptEdits,
} from "./script-check";

const words = (text: string, confidence?: number[]) =>
  text.split(" ").map((t, i) => ({
    text: t,
    ...(confidence ? { confidence: confidence[i] } : {}),
  }));

const SCRIPT = `HOOK: Most parents miss this.
At Tiny Acrobatics we start with tummy time in the prone position.
Ronnie Harker here. There are four things to do every day.
Their first year is so important, and you can't skip it.`;

describe("vetScriptEdits", () => {
  it("keeps a mis-heard name, spelled as in the script", () => {
    const heard = words("I'm Ronny Harker, and");
    expect(
      vetScriptEdits([{ from: 1, to: 2, text: "Ronnie Harker" }], heard, SCRIPT),
    ).toEqual([{ from: 1, to: 2, text: "Ronnie Harker," }]);
  });

  it("joins a brand the engine split up, keeping the run's punctuation", () => {
    const heard = words("at tiny acro batics, we");
    expect(
      vetScriptEdits([{ from: 1, to: 3, text: "Tiny Acrobatics" }], heard, SCRIPT),
    ).toEqual([{ from: 1, to: 3, text: "Tiny Acrobatics," }]);
  });

  it("fixes a name the engine heard as ordinary words that sound like it", () => {
    // a real transcript: the engine had never heard the brand
    const script = "So for 2 years building the Tiny Acrobatics program, parents wrote in.";
    const built = words("I built the Tiny Acro Batics program, but");
    const building = words("building the Tiny Acro Breaks program, whenever");
    expect(
      vetScriptEdits([{ from: 3, to: 5, text: "Tiny Acrobatics" }], built, script),
    ).toEqual([{ from: 3, to: 5, text: "Tiny Acrobatics" }]);
    // the model may leave the first word out of the run
    expect(
      vetScriptEdits([{ from: 4, to: 5, text: "Acrobatics" }], built, script),
    ).toEqual([{ from: 4, to: 5, text: "Acrobatics" }]);
    expect(
      vetScriptEdits([{ from: 2, to: 5, text: "Tiny Acrobatics program" }], building, script),
    ).toEqual([{ from: 2, to: 5, text: "Tiny Acrobatics program," }]);
  });

  it("changes the word count only for a phrase the script has", () => {
    const apart = "Tiny steps first. Then Acrobatics.";
    expect(
      vetScriptEdits([{ from: 1, to: 3, text: "Tiny Acrobatics" }], words("at tiny acro batics, we"), apart),
    ).toEqual([]);
  });

  it("fixes an uncommon word heard as a common one", () => {
    const heard = words("in the prawn position.");
    expect(
      vetScriptEdits([{ from: 2, to: 2, text: "prone" }], heard, SCRIPT),
    ).toEqual([{ from: 2, to: 2, text: "prone" }]);
  });

  it("fixes a homophone and keeps the transcript's sentence capital", () => {
    const heard = words("There first year is");
    // the script writes "Their" at a sentence start; the transcript's
    // capital stays because this is a sentence start too
    expect(
      vetScriptEdits([{ from: 0, to: 0, text: "their" }], heard, SCRIPT),
    ).toEqual([{ from: 0, to: 0, text: "Their" }]);
  });

  it("lowercases an ordinary word the script capitalized only to start a sentence", () => {
    const heard = words("and their are four");
    // the script also writes "there" mid-sentence: an ordinary word
    const withLower = `${SCRIPT}\nPut it over there.`;
    expect(
      vetScriptEdits([{ from: 1, to: 1, text: "There" }], heard, withLower),
    ).toEqual([{ from: 1, to: 1, text: "there" }]);
    // with only the sentence-start "There" it could be a name: kept as written
    expect(
      vetScriptEdits([{ from: 1, to: 1, text: "There" }], heard, SCRIPT),
    ).toEqual([{ from: 1, to: 1, text: "There" }]);
  });

  it("drops words the script doesn't have", () => {
    const heard = words("tummy time in the prawn position");
    expect(
      vetScriptEdits([{ from: 4, to: 4, text: "pron" }], heard, SCRIPT),
    ).toEqual([]);
  });

  it("drops a rewording toward the script (the speaker said it differently)", () => {
    // "miss" vs the script's "skip": both real words, not a mis-hearing
    const heard = words("you can't miss it");
    expect(
      vetScriptEdits([{ from: 2, to: 2, text: "skip" }], heard, SCRIPT),
    ).toEqual([]);
    expect(
      vetScriptEdits([{ from: 0, to: 0, text: "four" }], words("three things"), SCRIPT),
    ).toEqual([]);
  });

  it("never drops a spoken repeat or adds a word", () => {
    const heard = words("the the prone position");
    expect(
      vetScriptEdits([{ from: 0, to: 1, text: "the" }], heard, SCRIPT),
    ).toEqual([]);
    expect(
      vetScriptEdits(
        [{ from: 2, to: 3, text: "the prone position" }],
        words("in the prone position"),
        SCRIPT,
      ),
    ).toEqual([]);
    // ad-libs around a script phrase: the speaker said the extra words
    const script = "Here's how you can do exercises. The sample fights every movement.";
    expect(
      vetScriptEdits([{ from: 2, to: 3, text: "you can do exercises" }], words("Here's how you exercise"), script),
    ).toEqual([]);
    expect(
      vetScriptEdits([{ from: 2, to: 4, text: "every movement." }], words("she fights every single movement."), script),
    ).toEqual([]);
  });

  it("leaves number formatting alone", () => {
    const withNumber = `${SCRIPT}\nHe walked at 11 months.`;
    expect(
      vetScriptEdits([{ from: 3, to: 3, text: "11" }], words("he walked at eleven months"), withNumber),
    ).toEqual([]);
  });

  it("allows a capitals-only fix for a name, not for an ordinary word", () => {
    expect(
      vetScriptEdits([{ from: 1, to: 2, text: "Tiny Acrobatics" }], words("at tiny acrobatics we"), SCRIPT),
    ).toEqual([{ from: 1, to: 2, text: "Tiny Acrobatics" }]);
    expect(
      vetScriptEdits([{ from: 1, to: 1, text: "Most" }], words("and most parents"), SCRIPT),
    ).toEqual([]);
  });

  it("drops no-ops, out-of-range and overlapping edits", () => {
    const heard = words("the prawn position");
    expect(
      vetScriptEdits(
        [
          { from: 1, to: 1, text: "prone" },
          { from: 1, to: 2, text: "prone position" }, // overlaps the first
          { from: 2, to: 2, text: "position" }, // no change
          { from: 3, to: 3, text: "prone" }, // past the end
          { from: 2, to: 1, text: "prone" }, // backwards
        ],
        heard,
        SCRIPT,
      ),
    ).toEqual([{ from: 1, to: 1, text: "prone" }]);
  });

  it("caps how many words one edit may replace", () => {
    const heard = words("a b c d e f g");
    expect(
      vetScriptEdits([{ from: 0, to: 6, text: "Tiny" }], heard, SCRIPT),
    ).toEqual([]);
  });
});

describe("soundsAlike", () => {
  it("scores mis-hearings high and different words low", () => {
    expect(soundsAlike("prawn", "prone")).toBeGreaterThanOrEqual(0.5);
    expect(soundsAlike("Ronny Harker", "Ronnie Harker")).toBeGreaterThanOrEqual(0.5);
    expect(soundsAlike("their", "there")).toBeGreaterThanOrEqual(0.5);
    expect(soundsAlike("said", "told")).toBeLessThan(0.5);
    expect(soundsAlike("good", "great")).toBeLessThan(0.5);
    // a sound run in from the word before (a brand name heard as "…Back…")
    expect(soundsAlike("Back Breaks", "Acrobatics")).toBeGreaterThanOrEqual(0.6);
    expect(soundsAlike("Acro Batics", "Acrobatics")).toBeGreaterThanOrEqual(0.6);
    // outlines too short to compare only count by letters
    expect(soundsAlike("a", "I")).toBe(0);
  });
});

describe("scriptCheckPrompt", () => {
  it("numbers the words and shows confidence only where the engine was unsure", () => {
    const prompt = scriptCheckPrompt(SCRIPT, words("in the prawn position", [0.99, 0.97, 0.41, 0.95]));
    expect(prompt).toContain("Tiny Acrobatics");
    expect(prompt).toContain("0|in\n1|the\n2|prawn|0.41\n3|position");
  });

  it("gives a piece its global indices and the words around it as context", () => {
    const many = words(Array.from({ length: 50 }, (_, i) => `w${i}`).join(" "));
    const prompt = scriptCheckPrompt(SCRIPT, many, 20, 30);
    expect(prompt).toContain("indices 20-29");
    expect(prompt).toContain("20|w20");
    expect(prompt).not.toContain("30|w30");
    expect(prompt).toMatch(/Just before this part[^\n]*\n.*w19/);
    expect(prompt).toMatch(/Just after this part[^\n]*\nw30/);
  });
});

describe("parseScriptEdits", () => {
  it("reads fenced JSON and defaults `to` to `from`", () => {
    expect(
      parseScriptEdits('```json\n{"edits":[{"from":2,"text":" prone "},{"from":"x","to":1,"text":"a"}]}\n```'),
    ).toEqual([{ from: 2, to: 2, text: "prone" }]);
  });

  it("rejects an answer without an edits list, so the next provider is tried", () => {
    expect(() => parseScriptEdits("nothing to fix")).toThrow("no JSON");
    expect(() => parseScriptEdits('{"fixes": []}')).toThrow("no edits list");
  });
});

describe("scriptEdits", () => {
  beforeEach(() => {
    vi.mocked(completeWithFallback).mockReset();
  });

  it("checks the transcript and returns only vetted edits", async () => {
    vi.mocked(completeWithFallback).mockImplementation(async (_s, _p, _signal, parse) =>
      parse('{"edits":[{"from":2,"to":2,"text":"prone"},{"from":0,"to":0,"text":"at"}]}'),
    );
    const edits = await scriptEdits(SCRIPT, words("in the prawn position."));
    expect(edits).toEqual([{ from: 2, to: 2, text: "prone" }]);
    const [system, prompt] = vi.mocked(completeWithFallback).mock.calls[0];
    expect(system).toContain("mis-heard");
    expect(prompt).toContain("2|prawn");
  });

  it("drops an edit that reaches outside its own piece", async () => {
    // sentence ends every 100 words: two pieces of ~400 and ~500
    const long = words(
      Array.from({ length: 900 }, (_, i) => (i % 100 === 99 ? "prawn." : "prawn")).join(" "),
    );
    const firstIndex = (prompt: string) => Number(/^(\d+)\|/m.exec(prompt)![1]);
    vi.mocked(completeWithFallback).mockImplementation(async (_s, prompt, _signal, parse) => {
      const first = firstIndex(prompt);
      // each piece fixes its own first word and claims the word before it
      return parse(
        JSON.stringify({
          edits: [
            { from: first, to: first, text: "prone" },
            ...(first > 0 ? [{ from: first - 1, to: first - 1, text: "prone" }] : []),
          ],
        }),
      );
    });
    const edits = await scriptEdits(SCRIPT, long);
    const firsts = vi
      .mocked(completeWithFallback)
      .mock.calls.map(([, prompt]) => firstIndex(prompt))
      .sort((a, b) => a - b);
    expect(firsts).toEqual([0, 400]);
    expect(edits.map((e) => e.from)).toEqual([0, 400]);
  });
});
