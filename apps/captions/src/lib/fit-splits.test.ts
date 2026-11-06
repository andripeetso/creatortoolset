import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./refine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./refine")>()),
  // "So Tiny Acrobatics | is built", "for zero | to eighteen months."
  refineSplits: vi.fn(async (): Promise<number[][]> => [[3], [2]]),
}));

import { refineSplits } from "./refine";
import { loadClipSlots, useStudio, type ClipInfo, type ClipSnapshot } from "./store";
import { DEFAULT_STYLE, type Word } from "./types";

const initial = useStudio.getState();
// two matched thoughts, each wider than a 26-character line
const words: Word[] = "So Tiny Acrobatics is built for zero to eighteen months."
  .split(" ")
  .map((text, id) => ({ id, text, start: id * 0.3, end: id * 0.3 + 0.25, cut: id === 5 ? 2 : 0 }));
const style = { ...DEFAULT_STYLE, fitBox: true, fontSizePct: 2.5, boxW: 64.9, boxH: 4 };

beforeEach(() => {
  vi.clearAllMocks();
  const clip = { id: "c1", name: "c1", videoUrl: "blob:x", status: { phase: "done" } } as unknown as ClipInfo;
  const slot = {
    words,
    cues: [{ id: 1, start: 0, end: 3, words }],
    originalWords: null,
    style,
    posSegments: [],
    texts: [],
    cadenceApplied: true,
    cadenceFit: null,
    cadenceDirty: false,
    done: false,
    peaks: null,
    pcm: null,
    file: null,
  } as ClipSnapshot;
  loadClipSlots([[clip.id, slot]]);
  useStudio.setState({
    ...slot,
    clips: [clip],
    activeClipId: clip.id,
    sourceWidth: 2160,
    sourceHeight: 3840,
    videoWidth: 2160,
    videoHeight: 3840,
  });
});

afterEach(() => {
  loadClipSlots([]);
  useStudio.setState(initial, true);
});

const lines = () =>
  useStudio.getState().cues.map((c) => c.words.map((w) => w.text).join(" "));

describe("fitting long thought lines to the box", () => {
  it("sends only the lines wider than the box and splits them where the model said", async () => {
    await useStudio.getState().fitSplits();
    expect(vi.mocked(refineSplits).mock.calls[0]).toEqual([
      [
        ["So", "Tiny", "Acrobatics", "is", "built"],
        ["for", "zero", "to", "eighteen", "months."],
      ],
      26,
    ]);
    expect(lines()).toEqual(["So Tiny Acrobatics", "is built", "for zero", "to eighteen months."]);
    // the thoughts themselves are unchanged
    expect(useStudio.getState().words.filter((w) => w.cut === 2).map((w) => w.text)).toEqual(["for"]);
    expect(useStudio.getState().cadenceFit?.boxW).toBe(style.boxW);
  });

  it("drops the answer when the transcript changed while it ran", async () => {
    let finish!: (s: number[][]) => void;
    vi.mocked(refineSplits).mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const run = useStudio.getState().fitSplits();
    const edited = words.map((w) => ({ ...w }));
    useStudio.setState({ words: edited, cues: [{ id: 2, start: 0, end: 3, words: edited }] });
    finish([[3], [2]]);
    await run;
    expect(useStudio.getState().cues).toHaveLength(1);
  });

  it("asks nothing when every thought already fits", async () => {
    useStudio.getState().setStyle({ boxW: 90 });
    await useStudio.getState().fitSplits();
    expect(refineSplits).not.toHaveBeenCalled();
  });
});
