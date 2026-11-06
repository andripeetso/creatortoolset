import { describe, expect, it } from "vitest";
import { isEditorBusy } from "./store";
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
