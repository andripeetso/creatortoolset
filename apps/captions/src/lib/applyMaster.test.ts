import { describe, expect, it } from "vitest";
import { applyMasterToClip } from "./applyMaster";
import type { Cue, Word } from "./types";

let idCounter = 1000;
const nextId = () => idCounter++;
const nextPosId = () => idCounter++;

/** words at 0.3s spacing starting from t0 */
function ws(texts: string[], t0 = 0): Word[] {
  return texts.map((text, i) => ({
    id: idCounter++,
    text,
    start: t0 + i * 0.3,
    end: t0 + i * 0.3 + 0.25,
  }));
}

/** one cue per `per` words, mirroring a user's caption grouping */
function cuesOf(words: Word[], per: number): Cue[] {
  const cues: Cue[] = [];
  for (let i = 0; i < words.length; i += per) {
    const group = words.slice(i, i + per);
    cues.push({ id: idCounter++, start: group[0].start, end: group[group.length - 1].end, words: group });
  }
  return cues;
}

const run = (
  orig: Word[],
  master: Word[],
  masterCues: Cue[],
  target: Word[],
  targetCues: Cue[] = target.length ? cuesOf(target, target.length) : []
) =>
  applyMasterToClip(orig, master, masterCues, [], target, targetCues, 40, 2, nextPosId, nextId);

const texts = (words: Word[]) => words.map((w) => w.text);

describe("applyMasterToClip", () => {
  it("copies an untouched master verbatim and maps its cadence", () => {
    const orig = ws(["this", "costs", "two", "cents", "today", "only"]);
    const master = ws(["this", "costs", "two", "cents", "today", "only"]);
    const cues = cuesOf(master, 2);
    const target = ws(["this", "costs", "two", "cents", "today", "only"], 1.5);
    const res = run(orig, master, cues, target)!;
    expect(texts(res.words)).toEqual(texts(target));
    expect(res.coverage).toBe(1);
    expect(res.corrected).toBe(0);
    expect(res.inserted).toBe(0);
    // cadence transferred: 3 cues of 2 words
    expect(res.cues.map((c) => c.words.length)).toEqual([2, 2, 2]);
    // timing stays the target's own
    expect(res.words[0].start).toBeCloseTo(1.5);
  });

  it("replays a spelling fix with the target's timing kept", () => {
    const orig = ws(["this", "costs", "two", "sence"]);
    const master = ws(["this", "costs", "two", "cents"]); // user fixed sence → cents
    const target = ws(["this", "costs", "two", "sence"], 2);
    const res = run(orig, master, cuesOf(master, 4), target)!;
    expect(texts(res.words)).toEqual(["this", "costs", "two", "cents"]);
    expect(res.corrected).toBe(1);
    // the fixed word keeps the TARGET's timing, not the master's
    expect(res.words[3].start).toBeCloseTo(2 + 3 * 0.3);
    expect(res.inserted).toBe(0);
  });

  it("never rewrites target words the user didn't change on the master", () => {
    // the master's engine heard "two cents", the user touched nothing —
    // the target's "too sense" is its own business
    const orig = ws(["this", "costs", "two", "cents"]);
    const master = ws(["this", "costs", "two", "cents"]);
    const target = ws(["this", "costs", "too", "sense"], 1);
    const res = run(orig, master, cuesOf(master, 4), target)!;
    expect(texts(res.words)).toEqual(["this", "costs", "too", "sense"]);
    expect(res.corrected).toBe(0);
    expect(res.inserted).toBe(0);
  });

  it("keeps another take's wording instead of copying the master's in", () => {
    // Launch C (2026-10-03): the take says it differently — nothing of
    // the master's wording may land there, only its real fix elsewhere
    const orig = ws("six months ago I finally pulled the trigger and I got a second one of these units right here and the tension".split(" "));
    const master = ws("six months ago I finally pulled the trigger and I got a second one of these units right here and the attention".split(" "));
    const target = ws("six months ago we did a big investment and produced the second one of these here and the tension".split(" "), 3);
    const res = run(orig, master, cuesOf(master, 4), target)!;
    expect(texts(res.words).join(" ")).toBe(
      "six months ago we did a big investment and produced the second one of these here and the attention"
    );
    expect(res.inserted).toBe(0);
    expect(res.corrected).toBe(1);
  });

  it("lands a fix only where the target says the same words", () => {
    // the user rewrote "A hundred percent." on the master; this take said
    // "definitely" there — no positional swap
    const orig = ws(["it", "works", "A", "hundred", "percent", "for", "us"]);
    const master = ws(["it", "works", "100%", "for", "us"]);
    const target = ws(["it", "works", "definitely", "for", "us"], 2);
    const res = run(orig, master, cuesOf(master, 5), target)!;
    expect(texts(res.words)).toEqual(["it", "works", "definitely", "for", "us"]);
    const same = ws(["it", "works", "A", "hundred", "percent", "for", "us"], 2);
    const res2 = run(orig, master, cuesOf(master, 5), same)!;
    expect(texts(res2.words)).toEqual(["it", "works", "100%", "for", "us"]);
    // the new word spans the words it replaced
    expect(res2.words[2].start).toBeCloseTo(same[2].start);
    expect(res2.words[2].end).toBeLessThanOrEqual(same[4].end);
  });

  it("keeps the target's own caption breaks where it says its own words", () => {
    const orig = ws(["watch", "this", "trick", "now"]);
    const master = ws(["watch", "this", "trick", "now"]);
    const target = [...ws(["wait", "stop", "dont", "scroll"], -2), ...ws(["watch", "this", "trick", "now"], 0)];
    // the target's hook was grouped [wait stop][dont scroll]
    const targetCues = [...cuesOf(target.slice(0, 4), 2), ...cuesOf(target.slice(4), 4)];
    const res = run(orig, master, cuesOf(master, 2), target, targetCues)!;
    expect(res.cues.map((c) => texts(c.words).join(" "))).toEqual([
      "wait stop",
      "dont scroll",
      "watch this",
      "trick now",
    ]);
  });

  it("hands only names the replay couldn't place to the AI, never common words", () => {
    // the take says both spots differently: "CMON is" → "CMO needs" (a name)
    // goes on with its master context, "seem" → "seemed" stays put
    const orig = ws("and the CMON is my help so it seem fine".split(" "));
    const master = ws("and the CMO needs my help so it seemed fine".split(" "));
    const target = ws("and my c m needs help so they seem fine".split(" "), 1);
    const res = run(orig, master, cuesOf(master, 4), target)!;
    expect(res.missed).toEqual(["and the CMO needs my help so"]);
    expect(texts(res.words)).toEqual(texts(target));
  });

  it("is a no-op the second time", () => {
    const orig = ws(["um", "this", "costs", "sence", "today"]);
    const master = ws(["this", "costs", "two", "cents", "today"]);
    const target = ws(["um", "this", "costs", "sence", "today"], 1);
    const once = run(orig, master, cuesOf(master, 5), target)!;
    const twice = run(orig, master, cuesOf(master, 5), once.words, once.cues)!;
    expect(texts(twice.words)).toEqual(texts(once.words));
    expect(twice.inserted).toBe(0);
  });

  it("drops words the user deleted from the master", () => {
    const orig = ws(["um", "this", "costs", "two", "cents"]);
    const master = ws(["this", "costs", "two", "cents"]); // user cut "um"
    const target = ws(["um", "this", "costs", "two", "cents"], 3);
    const res = run(orig, master, cuesOf(master, 4), target)!;
    expect(texts(res.words)).toEqual(["this", "costs", "two", "cents"]);
    expect(res.words[0].start).toBeCloseTo(3.3);
  });

  it("inserts words the user added to the master into the target's gap", () => {
    const orig = ws(["this", "costs", "cents"]);
    // user added "two" between costs and cents
    const master = [
      ...ws(["this", "costs"], 0),
      { id: idCounter++, text: "two", start: 0.62, end: 0.75 },
      ...ws(["cents"], 0.9),
    ];
    const target = ws(["this", "costs", "cents"], 1); // 1.0, 1.3, 1.6
    const res = run(orig, master, cuesOf(master, 4), target)!;
    expect(texts(res.words)).toEqual(["this", "costs", "two", "cents"]);
    expect(res.inserted).toBe(1);
    const two = res.words[2];
    expect(two.start).toBeGreaterThan(res.words[1].start);
    // packed anchors → timing is borrowed around the gap midpoint
    expect(two.start).toBeLessThanOrEqual(res.words[3].start);
    expect(two.end).toBeLessThanOrEqual(res.words[3].end + 0.001);
  });

  it("never fills the target's holes with master words", () => {
    const orig = ws(["come", "on", "pspsps", "here", "kitty"]);
    const master = ws(["come", "on", "pspsps", "here", "kitty"]);
    // target engine dropped "pspsps" entirely
    const target = [
      ...ws(["come", "on"], 0),
      ...ws(["here", "kitty"], 1.2),
    ];
    const res = run(orig, master, cuesOf(master, 5), target)!;
    expect(texts(res.words)).toEqual(["come", "on", "here", "kitty"]);
    expect(res.inserted).toBe(0);
  });

  it("keeps a different intro hook untouched", () => {
    const orig = ws(["watch", "this", "magic", "trick", "now"]);
    const master = ws(["watch", "this", "magic", "trick", "now"]);
    // target leads with its own 4-word hook the master never says
    const target = [
      ...ws(["wait", "stop", "dont", "scroll"], -2),
      ...ws(["watch", "this", "magic", "trick", "now"], 0),
    ];
    const res = run(orig, master, cuesOf(master, 5), target)!;
    expect(texts(res.words)).toEqual(texts(target));
    expect(res.inserted).toBe(0);
    expect(res.coverage).toBeCloseTo(5 / 9);
  });

  it("replays punctuation edits word-by-word", () => {
    const orig = ws(["well,", "this", "is,", "it"]);
    const master = ws(["well", "this", "is", "it"]); // user stripped commas
    const target = ws(["well,", "this", "is,", "it"], 5);
    const res = run(orig, master, cuesOf(master, 4), target)!;
    expect(texts(res.words)).toEqual(["well", "this", "is", "it"]);
  });

  it("strips punctuation from target-only words when the user dropped it on the master", () => {
    const orig = ws(["look,", "at", "this"]);
    const master = ws(["look", "at", "this"]);
    const target = [
      { id: idCounter++, text: "hey,", start: -0.5, end: -0.3 },
      ...ws(["look", "at", "this"], 0),
    ];
    const res = run(orig, master, cuesOf(master, 3), target)!;
    expect(texts(res.words)).toEqual(["hey", "look", "at", "this"]);
  });

  it("keeps cue breaks aligned across deleted words", () => {
    const orig = ws(["um", "this", "costs", "two", "cents", "today"]);
    const master = ws(["this", "costs", "two", "cents", "today"]); // "um" cut
    const cues = cuesOf(master, 2); // [this costs][two cents][today]
    const target = ws(["um", "this", "costs", "two", "cents", "today"], 10);
    const res = run(orig, master, cues, target)!;
    expect(res.cues.map((c) => c.words.length)).toEqual([2, 2, 1]);
  });

  it("reports low coverage on genuinely different content", () => {
    const orig = ws(["this", "costs", "two", "cents", "today", "only"]);
    const master = ws(["this", "costs", "two", "cents", "today", "only"]);
    const target = ws(["totally", "unrelated", "words", "about", "baking", "bread"]);
    const res = run(orig, master, cuesOf(master, 3), target)!;
    expect(res.coverage).toBeLessThan(0.3);
  });

  it("handles a re-transcribed range as delete + insert", () => {
    // engine garbled the middle; user re-transcribed it on the master
    const orig = ws(["the", "quick", "brwn", "fx", "jumps", "over"]);
    const master = ws(["the", "quick", "brown", "fox", "jumps", "over"]);
    const target = ws(["the", "quick", "brwn", "fx", "jumps", "over"], 4);
    const res = run(orig, master, cuesOf(master, 6), target)!;
    expect(texts(res.words)).toEqual([
      "the",
      "quick",
      "brown",
      "fox",
      "jumps",
      "over",
    ]);
  });

  it("returns null for empty inputs", () => {
    expect(run([], [], [], [])).toBeNull();
  });
});
