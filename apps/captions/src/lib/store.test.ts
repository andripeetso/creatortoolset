import { describe, expect, it, vi } from "vitest";

vi.mock("./refine", async (original) => ({ ...(await original<typeof import("./refine")>()), aiStatus: vi.fn(async () => null) }));

import { aiStatus } from "./refine";
import { isEditorBusy, useStudio } from "./store";
import type { TranscribeStatus } from "./types";

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
