import { describe, expect, it, vi } from "vitest";

vi.mock("./refine", async (original) => ({ ...(await original<typeof import("./refine")>()), aiStatus: vi.fn(async () => null) }));

import { aiStatus } from "./refine";
import { isEditorBusy, useStudio } from "./store";
import { DEFAULT_STYLE, STYLE_PRESETS, type TranscribeStatus } from "./types";

const state = (status: TranscribeStatus, refining = false) => ({
  status,
  refining,
});

describe("isEditorBusy", () => {
  it.each<TranscribeStatus>([
    { phase: "extracting" },
    { phase: "loading", progress: 0.5, detail: "model" },
    { phase: "transcribing", progress: 0 },
    { phase: "matching" },
  ])("locks the editor during $phase", (status) => {
    expect(isEditorBusy(state(status))).toBe(true);
  });

  it.each<TranscribeStatus>([
    { phase: "idle" },
    { phase: "done" },
    { phase: "error", message: "failed" },
  ])("leaves the editor available during $phase", (status) => {
    expect(isEditorBusy(state(status))).toBe(false);
  });

  it("locks while a manual cadence pass is refining", () => {
    expect(isEditorBusy(state({ phase: "done" }, true))).toBe(true);
  });
});

describe("apply master", () => {
  it("pressed twice runs one pass: it is busy before the AI is asked", () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    useStudio.setState({
      clips: [{ id: "m", name: "Master", transcribed: true, status: { phase: "done" } }] as never,
      activeClipId: "m",
      words: [{ id: "w", text: "Hi", start: 0, end: 0.4 }] as never,
      cues: [],
    });
    void useStudio.getState().applyMasterToAll();
    void useStudio.getState().applyMasterToAll();
    expect(useStudio.getState().applyingMaster).toBe(true);
    expect(aiStatus).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe("captions clear of a reel's buttons", () => {
  const low = STYLE_PRESETS.find((p) => p.name === "Classic Low")!;
  const size = (w: number, h: number) => ({ sourceWidth: w, sourceHeight: h, videoWidth: w, videoHeight: h });

  it("a preset applied to a vertical video lands in the band; on landscape it keeps its place", () => {
    useStudio.setState({ ...size(1080, 1920), words: [], cues: [], cadenceApplied: false });
    useStudio.getState().applyPreset(low.name, low.style);
    const s = useStudio.getState().style;
    expect(s.boxY + s.boxH / 2).toBeCloseTo(65);
    useStudio.setState(size(1920, 1080));
    useStudio.getState().applyPreset(low.name, low.style);
    expect(useStudio.getState().style.boxY).toBe(low.style.boxY);
  });

  it("a new project on a vertical video places its captions once the size is known, an opened one never", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    const style = { ...DEFAULT_STYLE, boxY: 84, boxH: 14 };
    // opened: the person's place stays
    useStudio.setState({ ...size(0, 0), clips: [], activeClipId: "opened", style });
    useStudio.getState().setVideoMeta(1080, 1920, 3);
    expect(useStudio.getState().style.boxY).toBe(84);
    // new
    useStudio.setState({ style });
    useStudio.getState().importFiles([new File([""], "reel.mp4", { type: "video/mp4" })]);
    useStudio.getState().setVideoMeta(1080, 1920, 3);
    const placed = useStudio.getState().style;
    expect(placed.boxY + placed.boxH / 2).toBeCloseTo(65);
    // a second load of the same clip (reopened, proxy) leaves where the person moved it
    useStudio.setState({ style, sourceWidth: 0 });
    useStudio.getState().setVideoMeta(1080, 1920, 3);
    expect(useStudio.getState().style.boxY).toBe(84);
    vi.unstubAllGlobals();
  });
});
