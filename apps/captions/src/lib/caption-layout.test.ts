import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boxCaps, layoutCues } from "./captions";
import {
  cueLineCounts,
  layoutGroups,
  lineCountsFor,
  marksFromCues,
  sliceLines,
  tooWideThoughts,
  unplannedBreaks,
  withSplits,
} from "./caption-layout";
import { isSentenceEnd } from "./caption-constraints";
import { DEFAULT_STYLE, type Cue, type Word } from "./types";

interface Fixture {
  frame: { width: number; height: number };
  style: { fontSizePct: number; boxW: number; boxH: number };
  approved: string[];
  words: { text: string; start: number; end: number; utterance?: number }[];
}
const clip = JSON.parse(
  readFileSync(new URL("./__fixtures__/cadence-clip-01.json", import.meta.url), "utf8"),
) as Fixture;

/** The clip's words as the fixed seam merge keeps them (one copy per word). */
function clipWords(): Word[] {
  const cut = (k: number) => (k === 0 ? -Infinity : k * 43 + 1);
  return clip.words
    .filter((w) => {
      const k = Math.floor((w.utterance ?? 0) / 1000);
      return w.start >= cut(k) && w.start < cut(k + 1);
    })
    .map((w, id) => ({ id, text: w.text, start: w.start, end: w.end }));
}

let nextId = 1000;
const newId = () => nextId++;

function words(text: string, step = 0.2): Word[] {
  return text.split(" ").map((t, id) => ({
    id,
    text: t,
    start: id * step,
    end: id * step + step * 0.9,
  }));
}

/** Mark each approved line start as a new thought. */
function markLines(ws: Word[], lines: string[]): Word[] {
  const starts = new Set<number>();
  let at = 0;
  for (const line of lines) {
    starts.add(at);
    at += line.split(" ").length;
  }
  return ws.map((w, i) => ({ ...w, cut: i > 0 && starts.has(i) ? 2 : 0 }));
}

const text = (ws: { text: string }[]) => ws.map((w) => w.text).join(" ");
const screenLines = (cues: Cue[], maxChars: number) =>
  cues.flatMap((c) => sliceLines(c.words, cueLineCounts(c, maxChars)).map(text));

describe("caption layout on the real reel", () => {
  const all = clipWords();
  const opening = all.slice(0, clip.approved.join(" ").split(" ").length);

  it("reads the clip's box as 28 characters by one line", () => {
    const caps = boxCaps({ ...DEFAULT_STYLE, ...clip.style }, clip.frame.width, clip.frame.height);
    expect(caps).toEqual({ maxChars: 28, maxLines: 1 });
    expect(text(opening)).toBe(clip.approved.join(" "));
  });

  it.each([
    [28, 1],
    [28, 2],
    [28, 3],
    [20, 1],
    [20, 2],
    [20, 3],
    [36, 2],
  ])("never draws more lines than a %i×%i box holds, and loses no word", (maxChars, maxLines) => {
    for (const ws of [all, markLines(opening, clip.approved)]) {
      const cues = layoutCues(ws, { maxChars, maxLines });
      for (const cue of cues) {
        const lines = sliceLines(cue.words, cueLineCounts(cue, maxChars));
        expect(lines.length).toBeLessThanOrEqual(maxLines);
        for (const line of lines) {
          if (line.length > 1) expect(text(line).length).toBeLessThanOrEqual(maxChars);
          // a sentence end is always the last word on its line
          line.slice(0, -1).forEach((w) => expect(isSentenceEnd(w.text)).toBe(false));
        }
      }
      expect(cues.flatMap((c) => c.words).map((w) => w.id)).toEqual(ws.map((w) => w.id));
    }
  });

  it("shows the approved thoughts exactly in the clip's one-line box", () => {
    const cues = layoutCues(markLines(opening, clip.approved), { maxChars: 28, maxLines: 1 });
    expect(cues.map((c) => text(c.words))).toEqual(clip.approved);
  });

  it("stacks whole thoughts, one per line, when the box is taller", () => {
    const cues = layoutCues(markLines(opening, clip.approved), { maxChars: 28, maxLines: 3 });
    expect(screenLines(cues, 28)).toEqual(clip.approved);
    expect(cues.length).toBeLessThan(clip.approved.length);
    expect(Math.max(...cues.map((c) => cueLineCounts(c, 28).length))).toBe(3);
  });

  it("splits a thought too wide for a narrow box without mixing it with the next", () => {
    const cues = layoutCues(markLines(opening, clip.approved), { maxChars: 20, maxLines: 1 });
    const shown = screenLines(cues, 20);
    // every thought's words stay among its own lines
    let at = 0;
    for (const thought of clip.approved) {
      const n = thought.split(" ").length;
      let joined = "";
      while (joined.split(" ").filter(Boolean).length < n) {
        joined = (joined ? joined + " " : "") + shown[at++];
      }
      expect(joined).toBe(thought);
    }
  });
});

describe("splitting a line that is too wide", () => {
  it("uses the matched split point", () => {
    const ws = words("So here's everything we did").map((w, i) => ({
      ...w,
      cut: (i === 2 ? 1 : i === 0 ? 2 : 0) as 0 | 1 | 2,
    }));
    const cues = layoutCues(ws, { maxChars: 20, maxLines: 1 });
    expect(cues.map((c) => text(c.words))).toEqual(["So here's", "everything we did"]);
  });

  it("follows Netflix line treatment without marks: before the preposition, not after an article", () => {
    const ws = words("The app got its own top at less than a month");
    expect(sliceLines(ws, lineCountsFor(ws, 24)).map(text)).toEqual([
      "The app got its own top",
      "at less than a month",
    ]);
  });

  it("gives a word wider than the box a line of its own", () => {
    const ws = words("a supercalifragilistic word");
    const cues = layoutCues(ws, { maxChars: 10, maxLines: 1 });
    expect(cues.map((c) => text(c.words))).toEqual(["a", "supercalifragilistic", "word"]);
  });
});

describe("stacking", () => {
  it("does not stack more than about five seconds of speech", () => {
    const ws = words("one two three four five six", 1.5).map((w) => ({ ...w, cut: 2 as const }));
    const cues = layoutCues(ws, { maxChars: 30, maxLines: 6 });
    for (const c of cues) {
      expect(c.words[c.words.length - 1].end - c.words[0].start).toBeLessThanOrEqual(5);
    }
  });

  it("may end a sentence and start the next on the following line", () => {
    const ws = words("and walked at 11. So here's everything");
    const cues = layoutCues(ws, { maxChars: 20, maxLines: 2 });
    expect(screenLines(cues, 20)).toEqual(["and walked at 11.", "So here's everything"]);
    expect(cues).toHaveLength(1);
  });

  it("keeps a caption's id when it still opens on the same word", () => {
    const ws = markLines(words("aa bb cc dd ee ff"), ["aa bb", "cc dd", "ee ff"]);
    const one = layoutCues(ws, { maxChars: 10, maxLines: 1 });
    const two = layoutCues(ws, { maxChars: 10, maxLines: 2 }, one);
    expect(two[0].id).toBe(one[0].id);
    expect(new Set(two.map((c) => c.id)).size).toBe(two.length);
  });
});

describe("captions grouped elsewhere", () => {
  it("wraps a manual line to the box and splits it only past the box height", () => {
    const cues = layoutGroups([words("walked at 11. So here's everything we did")], { maxChars: 40, maxLines: 1 }, newId);
    expect(cues.map((c) => text(c.words))).toEqual(["walked at 11.", "So here's everything we did"]);
  });

  it("keeps a manual line whole when the box has room for its lines", () => {
    const g = words("into this happy, healthy, resilient human");
    const cues = layoutGroups([g], { maxChars: 20, maxLines: 3 }, newId);
    expect(cues).toHaveLength(1);
    expect(cues[0].lines?.reduce((a, b) => a + b, 0)).toBe(g.length);
  });

  it("draws stored lines, and re-wraps when they no longer match", () => {
    const ws = words("aa bb cc dd");
    expect(cueLineCounts({ words: ws, lines: [1, 3] }, 20)).toEqual([1, 3]);
    expect(cueLineCounts({ words: ws, lines: [1, 1] }, 20)).toEqual([4]);
    expect(cueLineCounts({ words: ws, lines: [4] }, 5)).toEqual([2, 2]);
  });

  it("turns an older matched grouping's caption starts into thought marks", () => {
    const ws = words("aa bb cc dd");
    const cues = layoutGroups([ws.slice(0, 2), ws.slice(2)], { maxChars: 20, maxLines: 1 }, newId);
    expect(marksFromCues(cues)?.map((w) => w.cut)).toEqual([0, 0, 2, 0]);
    const marked = cues.map((c) => ({ ...c, words: c.words.map((w) => ({ ...w, cut: 0 as const })) }));
    expect(marksFromCues(marked)).toBeNull();
  });
});

describe("sentence ends", () => {
  it("does not treat 3.5 or Dr. as a sentence boundary", () => {
    expect(isSentenceEnd("3.5")).toBe(false);
    expect(isSentenceEnd("Dr.")).toBe(false);
    expect(isSentenceEnd("11.")).toBe(true);
    const cues = layoutCues(words("about 3.5 months later Dr. Kim said hi."), { maxChars: 40, maxLines: 1 });
    expect(cues.map((c) => text(c.words))).toEqual(["about 3.5 months later Dr. Kim said hi."]);
  });
});

describe("noticing a box narrower than the match planned for", () => {
  const ws = markLines(words("So Tiny Acrobatics is built for zero to eighteen months."), [
    "So Tiny Acrobatics is built",
    "for zero to eighteen months.",
  ]);

  it("counts nothing when every line breaks where the match marked it", () => {
    expect(unplannedBreaks(layoutCues(ws, { maxChars: 28, maxLines: 1 }))).toBe(0);
  });

  it("counts lines the layout had to break without a mark", () => {
    expect(unplannedBreaks(layoutCues(ws, { maxChars: 20, maxLines: 1 }))).toBeGreaterThan(0);
  });

  it("counts nothing once the match marked where those lines split", () => {
    const marked = ws.map((w) =>
      w.text === "is" || w.text === "to" ? { ...w, cut: 1 as const } : w,
    );
    expect(unplannedBreaks(layoutCues(marked, { maxChars: 20, maxLines: 1 }))).toBe(0);
  });

  it("stays quiet before any match", () => {
    expect(unplannedBreaks(layoutCues(words("a b c d e f g h"), { maxChars: 3, maxLines: 1 }))).toBe(0);
  });
});

describe("thought lines and planned splits", () => {
  const ws = markLines(words("So Tiny Acrobatics is built for zero to eighteen months. But"), [
    "So Tiny Acrobatics is built",
    "for zero to eighteen months.",
    "But",
  ]);

  it("lists the thought lines wider than the box", () => {
    expect(tooWideThoughts(ws, 26)).toEqual([
      [0, 5],
      [5, 10],
    ]);
    expect(tooWideThoughts(ws, 30)).toEqual([]);
  });

  it("puts planned split points in, and leaves thought starts alone", () => {
    const next = withSplits(ws, tooWideThoughts(ws, 26), [[3], [2]]);
    expect(next.map((w) => w.cut)).toEqual([0, 0, 0, 1, 0, 2, 0, 1, 0, 0, 2]);
  });
});
