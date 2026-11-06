import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadClipSlots, useStudio } from "./store";
import { DEFAULT_STYLE, type Word } from "./types";

const initial = useStudio.getState();
// words with pauses between them, so captions have gaps to fill
const words: Word[] = "So Tiny Acrobatics is built for zero to eighteen months and every day counts"
  .split(" ")
  .map((text, id) => ({ id, text, start: id * 0.6, end: id * 0.6 + 0.3 }));
const style = { ...DEFAULT_STYLE, fitBox: true, fontSizePct: 2.5, boxW: 40, boxH: 4 };

beforeEach(() => {
  useStudio.setState({
    words,
    cues: [],
    style,
    duration: 12,
    sourceWidth: 2160,
    sourceHeight: 3840,
    videoWidth: 2160,
    videoHeight: 3840,
    status: { phase: "done" },
  });
  // lay the words out for the box (a box change re-lays out)
  useStudio.getState().setStyle({ boxW: 41 });
});

afterEach(() => {
  loadClipSlots([]);
  useStudio.setState(initial, true);
});

const touching = () => {
  const cues = useStudio.getState().cues;
  return cues.slice(0, -1).every((c, i) => Math.abs(c.end - (cues[i + 1].start - 0.001)) < 1e-9);
};

describe("Fill gaps", () => {
  it("stays filled when a box or font change re-lays the captions out", () => {
    expect(useStudio.getState().cues.length).toBeGreaterThan(2);
    expect(touching()).toBe(false);
    useStudio.getState().fillGaps();
    expect(touching()).toBe(true);
    const before = useStudio.getState().cues.length;
    useStudio.getState().setStyle({ fontSizePct: 3.5 });
    expect(useStudio.getState().cues.length).not.toBe(before); // regrouped
    expect(touching()).toBe(true);
  });

  it("keeps a hand-dragged edge, and turning it off ends captions with their words", () => {
    useStudio.getState().fillGaps();
    const c = useStudio.getState().cues[0];
    useStudio.getState().updateCueTimes(c.id, c.start, c.end - 0.2);
    expect(useStudio.getState().cues[0].end).toBeCloseTo(c.end - 0.2);
    useStudio.getState().fillGaps();
    const after = useStudio.getState().cues[0];
    expect(after.end).toBeCloseTo(after.words[after.words.length - 1].end + 0.08);
    expect(useStudio.getState().style.fillGaps).toBe(false);
  });
});
