import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./refine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./refine")>()),
  aiStatus: vi.fn(async () => ({ available: true, allowed: true })),
  // "keep moving forward" / "and trust yourself"
  refineSegments: vi.fn(async (): Promise<(0 | 1 | 2)[]> => [2, 0, 0, 2, 0, 0]),
  checkAgainstScript: vi.fn(async () => [{ from: 4, to: 4, text: "trust" }]),
}));

import { checkAgainstScript, refineSegments } from "./refine";
import {
  enqueueTranscription,
  loadClipSlots,
  useStudio,
  type ClipInfo,
  type ClipSnapshot,
} from "./store";
import { CLOUD_MODEL_ID } from "./transcribe";
import { DEFAULT_STYLE } from "./types";

const SCRIPT = "Keep moving forward and trust yourself.";
const initial = useStudio.getState();
// the engine mis-heard "trust"
const transcript = "keep moving forward and trussed yourself"
  .split(" ")
  .map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.25 }));

const text = () => useStudio.getState().words.map((w) => w.text).join(" ");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url !== "/api/transcribe") throw new Error(`Unexpected request: ${url}`);
      return new Response(JSON.stringify({ words: transcript }));
    }),
  );
  useStudio.setState(initial, true);
  const clip: ClipInfo = {
    id: "scripted",
    name: "scripted.mov",
    videoUrl: "blob:scripted",
    duration: 2,
    sourceWidth: 1080,
    sourceHeight: 1920,
    srcFps: 30,
    status: { phase: "idle" },
    transcribed: false,
    uploadState: "local",
    uploadPct: 0,
    uploadError: null,
    hasOriginal: false,
    originalBytes: 0,
    done: false,
  };
  const slot: ClipSnapshot = {
    words: [],
    cues: [],
    originalWords: null,
    style: { ...DEFAULT_STYLE, fitBox: false, maxCharsPerLine: 30 },
    posSegments: [],
    texts: [],
    cadenceApplied: false,
    cadenceFit: null,
    cadenceDirty: false,
    done: false,
    peaks: null,
    pcm: new Float32Array(16000),
    file: null,
  };
  loadClipSlots([[clip.id, slot]]);
  useStudio.setState({
    ...slot,
    clips: [clip],
    activeClipId: clip.id,
    model: CLOUD_MODEL_ID,
    autoCadence: true,
    script: SCRIPT,
    videoUrl: clip.videoUrl,
    sourceWidth: 1080,
    sourceHeight: 1920,
    videoWidth: 1080,
    videoHeight: 1920,
  });
});

afterEach(() => {
  loadClipSlots([]);
  useStudio.setState(initial, true);
  vi.unstubAllGlobals();
});

const waitForDone = () =>
  vi.waitFor(
    () => expect(useStudio.getState().clips[0].status.phase).toBe("done"),
    { timeout: 2000 },
  );

describe("script check after transcription", () => {
  it("fixes mis-heard words from the script before cadence groups them", async () => {
    let answer!: (edits: { from: number; to: number; text: string }[]) => void;
    vi.mocked(checkAgainstScript).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    enqueueTranscription(["scripted"]);
    await vi.waitFor(() => expect(checkAgainstScript).toHaveBeenCalledOnce());
    // editing stays locked through the check, and cadence waits for it
    expect(useStudio.getState().status.phase).toBe("checking");
    expect(refineSegments).not.toHaveBeenCalled();
    const [script, sent] = vi.mocked(checkAgainstScript).mock.calls[0];
    expect(script).toBe(SCRIPT);
    expect(sent.map((w) => w.text).join(" ")).toBe(
      "keep moving forward and trussed yourself",
    );

    answer([{ from: 4, to: 4, text: "trust" }]);
    await waitForDone();
    const state = useStudio.getState();
    expect(text()).toBe("keep moving forward and trust yourself");
    // cadence grouped the fixed words
    expect(vi.mocked(refineSegments).mock.calls[0][0].map((w) => w.text)).toContain("trust");
    expect(state.cadenceApplied).toBe(true);
    const fixed = state.words[4];
    expect(fixed).toMatchObject({ start: transcript[4].start, end: transcript[4].end });
    expect(state.scriptFixes.scripted).toEqual([
      { ids: [fixed.id], before: "trussed", after: "trust" },
    ]);

    // undo steps back through cadence, then through the fixes
    state.undoEdit();
    expect(useStudio.getState().cadenceApplied).toBe(false);
    expect(text()).toBe("keep moving forward and trust yourself");
    useStudio.getState().undoEdit();
    expect(text()).toBe("keep moving forward and trussed yourself");
  });

  it("skips the check when the project has no script", async () => {
    useStudio.setState({ script: "  " });
    enqueueTranscription(["scripted"]);
    await waitForDone();
    expect(checkAgainstScript).not.toHaveBeenCalled();
    expect(refineSegments).toHaveBeenCalledOnce();
  });

  it("keeps the transcript as heard and still matches cadence when the check fails", async () => {
    vi.mocked(checkAgainstScript).mockRejectedValueOnce(new Error("Provider unavailable"));
    enqueueTranscription(["scripted"]);
    await waitForDone();
    expect(text()).toBe("keep moving forward and trussed yourself");
    expect(useStudio.getState().scriptCheckError).toBe("Provider unavailable");
    expect(useStudio.getState().cadenceApplied).toBe(true);
  });

  it("goes on to cadence with the words as heard when the check is stopped", async () => {
    vi.mocked(checkAgainstScript).mockImplementationOnce(
      (_script, _words, { signal } = {}) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    enqueueTranscription(["scripted"]);
    await vi.waitFor(() => expect(checkAgainstScript).toHaveBeenCalledOnce());
    useStudio.getState().cancelScriptCheck();
    await waitForDone();
    expect(text()).toBe("keep moving forward and trussed yourself");
    expect(useStudio.getState().scriptCheckError).toBeNull();
    expect(useStudio.getState().cadenceApplied).toBe(true);
  });

  it("runs on demand and keeps the caption grouping", async () => {
    useStudio.setState({ script: "" });
    enqueueTranscription(["scripted"]);
    await waitForDone();
    const lines = () =>
      useStudio.getState().cues.map((c) => c.words.map((w) => w.text).join(" "));
    expect(lines()).toEqual(["keep moving forward", "and trussed yourself"]);

    useStudio.getState().setScript(SCRIPT);
    await useStudio.getState().checkScript();
    expect(useStudio.getState().status.phase).toBe("done");
    expect(lines()).toEqual(["keep moving forward", "and trust yourself"]);
    useStudio.getState().undoEdit();
    expect(lines()).toEqual(["keep moving forward", "and trussed yourself"]);
  });
});
