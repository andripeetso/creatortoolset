import { describe, expect, it } from "vitest";
import { buildRecoveryProject, holdsUnsentChanges, type RecoveryProject } from "./local-recovery";
import { useStudio, type ClipInfo } from "./store";
import { DEFAULT_STYLE, type TranscribeStatus, type Word } from "./types";

const clip: ClipInfo = {
  id: "c1", name: "tumbles.mp4", videoUrl: "/api/projects/p1/clips/c1/video", duration: 2.4, sourceWidth: 360, sourceHeight: 640, srcFps: 30,
  status: { phase: "idle" }, transcribed: false, uploadState: "done", uploadPct: 100, uploadError: null, hasOriginal: true, originalBytes: 1, done: false,
};
const stored = (saveState: "idle" | "saving" | "saved" | "error", status: TranscribeStatus = { phase: "idle" }, clips = [clip]) =>
  buildRecoveryProject({ ...useStudio.getState(), projectId: "p1", serverProjectReady: true, activeClipId: "c1", clips, saveState, status })!;

describe("this browser's stored copy of a project", () => {
  it("says whether the page had changes the server had not taken when it was written", () => {
    expect(stored("saved").unsynced).toBe(false);
    expect(stored("idle").unsynced).toBe(false);
    expect(stored("saving").unsynced).toBe(true);
    expect(stored("error").unsynced).toBe(true);
    // a transcript that has landed while its lines are still being matched, or after a failed run: the autosave sends nothing then
    expect(stored("saved", { phase: "matching" }).unsynced).toBe(true);
    expect(stored("saved", { phase: "error", message: "no sound" }).unsynced).toBe(true);
    expect(stored("saved", { phase: "done" }).unsynced).toBe(false);
    expect(stored("saved", { phase: "idle" }, [clip, { ...clip, id: "c2", status: { phase: "transcribing", progress: 0 } }]).unsynced).toBe(true);
  });

  it("is sent to the server when opened again only if it holds such changes; a copy from before that was recorded is sent when it has a transcript or a text", () => {
    const slot = (over: Partial<RecoveryProject["clips"][number]["slot"]> = {}) => ({
      words: [], cues: [], originalWords: null, style: DEFAULT_STYLE, posSegments: [], texts: [], cadenceApplied: false, cadenceFit: null, cadenceDirty: false, done: false, ...over,
    });
    const copy = (unsynced: boolean | undefined, s = slot()) => ({ unsynced, clips: [{ info: clip, slot: s }] });
    const word: Word = { id: 1, text: "Tiny", start: 0, end: 0.4 };
    expect(holdsUnsentChanges(copy(true))).toBe(true);
    expect(holdsUnsentChanges(copy(false, slot({ words: [word] })))).toBe(false);
    expect(holdsUnsentChanges(copy(undefined))).toBe(false);
    expect(holdsUnsentChanges(copy(undefined, slot({ words: [word] })))).toBe(true);
  });
});
