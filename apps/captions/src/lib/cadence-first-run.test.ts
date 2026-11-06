import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./refine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./refine")>()),
  aiStatus: vi.fn(async () => ({ available: true, allowed: true })),
  // "keep moving forward" / "and trust yourself"
  refineSegments: vi.fn(async (): Promise<(0 | 1 | 2)[]> => [2, 0, 0, 2, 0, 0]),
}));

import { refineSegments } from "./refine";
import {
  enqueueTranscription,
  loadClipSlots,
  useStudio,
  type ClipInfo,
  type ClipSnapshot,
} from "./store";
import { CLOUD_MODEL_ID } from "./transcribe";
import { DEFAULT_STYLE } from "./types";

const initial = useStudio.getState();
const transcript = "keep moving forward and trust yourself"
  .split(" ")
  .map((text, i) => ({
    text,
    start: i * 0.3,
    end: i * 0.3 + 0.25,
  }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url !== "/api/transcribe")
        throw new Error(`Unexpected request: ${url}`);
      return new Response(JSON.stringify({ words: transcript }));
    }),
  );
  useStudio.setState(initial, true);
  const clip: ClipInfo = {
    id: "first-run",
    name: "first-run.mov",
    videoUrl: "blob:first-run",
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
    () => {
      expect(useStudio.getState().clips[0].status.phase).toBe("done");
    },
    { timeout: 2000 },
  );

describe("first-run automatic cadence", () => {
  it("actually applies the AI grouping before declaring transcription done", async () => {
    let finish!: (marks: (0 | 1 | 2)[]) => void;
    vi.mocked(refineSegments).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    enqueueTranscription(["first-run"]);
    await vi.waitFor(() => expect(refineSegments).toHaveBeenCalledOnce());
    expect(useStudio.getState().status.phase).toBe("matching");
    expect(useStudio.getState().cadenceApplied).toBe(false);
    finish([2, 0, 0, 2, 0, 0]);
    await waitForDone();
    const state = useStudio.getState();
    expect(state.cadenceApplied).toBe(true);
    expect(state.cadenceRunOutcome).toBe("completed");
    expect(state.cues.map((c) => c.words.map((w) => w.text).join(" "))).toEqual(
      ["keep moving forward", "and trust yourself"],
    );
    expect(state.clips[0].uploadState).toBe("local");
  });

  it("does not claim cadence was applied when the first request fails", async () => {
    vi.mocked(refineSegments).mockRejectedValueOnce(
      new Error("Provider unavailable"),
    );
    enqueueTranscription(["first-run"]);
    await waitForDone();
    expect(useStudio.getState().cadenceApplied).toBe(false);
    expect(useStudio.getState().cadenceRunOutcome).toBe("failed");
    expect(useStudio.getState().words).toHaveLength(transcript.length);
  });

  it("skips automatic matching when the project has it disabled", async () => {
    useStudio.setState({ autoCadence: false });
    enqueueTranscription(["first-run"]);
    await waitForDone();
    expect(refineSegments).not.toHaveBeenCalled();
    expect(useStudio.getState().cadenceApplied).toBe(false);
  });

  it("uses a new AI proposal when explicitly re-run", async () => {
    enqueueTranscription(["first-run"]);
    await waitForDone();
    const before = useStudio
      .getState()
      .cues.map((c) => c.words.map((w) => w.text).join(" "));
    // "keep moving" / "forward and trust yourself"
    vi.mocked(refineSegments).mockResolvedValueOnce([2, 0, 2, 0, 0, 0]);
    await useStudio.getState().refineCues();
    expect(refineSegments).toHaveBeenCalledTimes(2);
    expect(useStudio.getState().cadenceApplied).toBe(true);
    expect(
      useStudio
        .getState()
        .cues.map((c) => c.words.map((w) => w.text).join(" ")),
    ).not.toEqual(before);
  });
});
