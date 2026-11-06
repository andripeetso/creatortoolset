import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./refine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./refine")>()),
  aiStatus: vi.fn(async () => ({ available: false, allowed: false })),
  checkAgainstScript: vi.fn(async () => []),
}));

import { aiStatus, checkAgainstScript } from "./refine";

import {
  getClipSnapshot,
  isMasterApplyReady,
  loadClipSlots,
  useStudio,
  type ClipInfo,
  type ClipSnapshot,
} from "./store";
import { DEFAULT_STYLE, type TranscribeStatus, type Word } from "./types";

const initialState = useStudio.getState();
const uploadStates: ClipInfo["uploadState"][] = [
  "local",
  "uploading",
  "processing",
  "error",
  "done",
];

function clip(id: string, uploadState: ClipInfo["uploadState"]): ClipInfo {
  return {
    id,
    name: `${id}.mov`,
    videoUrl: `blob:${id}`,
    duration: 10,
    sourceWidth: 1080,
    sourceHeight: 1920,
    srcFps: 30,
    status: { phase: "done" },
    transcribed: true,
    uploadState,
    uploadPct: uploadState === "done" ? 100 : 0,
    uploadError: null,
    hasOriginal: uploadState === "done",
    originalBytes: 0,
    done: false,
  };
}

function snapshot(corrected: boolean, offset = 0): ClipSnapshot {
  const words: Word[] = [
    "this",
    "costs",
    "two",
    corrected ? "cents" : "sence",
  ].map((text, id) => ({
    id,
    text,
    start: offset + id * 0.3,
    end: offset + id * 0.3 + 0.25,
  }));
  return {
    words,
    cues: [{ id: 1, start: words[0].start, end: words[3].end, words }],
    originalWords: words.map((w) => ({
      ...w,
      text: w.id === 3 ? "sence" : w.text,
    })),
    style: DEFAULT_STYLE,
    posSegments: [],
    texts: [],
    cadenceApplied: false,
    cadenceFit: null,
    cadenceDirty: false,
    done: false,
    peaks: null,
    pcm: null,
    file: null,
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  useStudio.setState(initialState, true);
  loadClipSlots([]);
});

afterEach(() => {
  loadClipSlots([]);
  useStudio.setState(initialState, true);
  vi.unstubAllGlobals();
});

describe("master apply readiness", () => {
  it.each(uploadStates)(
    "accepts captioned clips while upload is %s",
    (uploadState) => {
      expect(isMasterApplyReady(clip("target", uploadState))).toBe(true);
    },
  );

  it.each<TranscribeStatus>([
    { phase: "extracting" },
    { phase: "loading", progress: 0, detail: "model" },
    { phase: "transcribing", progress: 0 },
    { phase: "matching" },
  ])("blocks a transcript being changed during $phase", (status) => {
    expect(isMasterApplyReady({ ...clip("target", "done"), status })).toBe(
      false,
    );
  });

  it("requires a transcript even after upload completes", () => {
    expect(
      isMasterApplyReady({ ...clip("target", "done"), transcribed: false }),
    ).toBe(false);
  });
});

describe("applying master before video upload completes", () => {
  function seed(uploadState: ClipInfo["uploadState"]) {
    const master = snapshot(true);
    loadClipSlots([
      ["master", master],
      ["target", snapshot(false, 2)],
      ["other", snapshot(false, 4)],
    ]);
    useStudio.setState({
      ...master,
      clips: [
        clip("master", "local"),
        clip("target", uploadState),
        clip("other", "done"),
      ],
      activeClipId: "master",
    });
  }

  it.each(uploadStates)(
    "applies corrections to selected %s clips and preserves timing",
    async (uploadState) => {
      seed(uploadState);
      await useStudio.getState().applyMasterToAll(["target"]);
      const target = getClipSnapshot("target")!;
      expect(target.words.map((w) => w.text)).toEqual([
        "this",
        "costs",
        "two",
        "cents",
      ]);
      expect(target.words[3].start).toBeCloseTo(2.9);
      expect(target.cadenceApplied).toBe(true);
      expect(getClipSnapshot("other")!.words[3].text).toBe("sence");
      expect(useStudio.getState().masterApplyResults?.target).toBe(1);
      expect(useStudio.getState().clips[1].uploadState).toBe(uploadState);
    },
  );

  it.each([{ ids: [] }, { ids: ["removed-clip"] }])(
    "never widens an empty or stale selection ($ids) to all",
    async ({ ids }) => {
      seed("done");
      await useStudio.getState().applyMasterToAll(ids);
      expect(getClipSnapshot("target")!.words[3].text).toBe("sence");
      expect(getClipSnapshot("other")!.words[3].text).toBe("sence");
    },
  );

  it("leaves a target alone while its transcript is being regenerated", async () => {
    seed("done");
    useStudio.setState((s) => ({
      clips: s.clips.map((c) =>
        c.id === "target"
          ? { ...c, status: { phase: "transcribing", progress: 0 } }
          : c,
      ),
    }));
    await useStudio.getState().applyMasterToAll(["target"]);
    expect(getClipSnapshot("target")!.words[3].text).toBe("sence");
  });
});

describe("the AI's part in apply-master", () => {
  const words = (texts: string[], offset = 0): Word[] =>
    texts.map((text, i) => ({
      id: i + 1,
      text,
      start: offset + i * 0.3,
      end: offset + i * 0.3 + 0.25,
    }));
  const slot = (cur: Word[], orig: Word[]): ClipSnapshot => ({
    ...snapshot(false),
    words: cur,
    cues: [{ id: 1, start: cur[0].start, end: cur[cur.length - 1].end, words: cur }],
    originalWords: orig,
  });

  it("places a master name fix where the take mis-heard it, from the fixes alone", async () => {
    const master = words("and the CMO needs my help".split(" "));
    const target = words("and my c m needs help".split(" "), 2);
    loadClipSlots([
      ["master", slot(master, words("and the CMON is my help".split(" ")))],
      ["target", slot(target, target)],
    ]);
    useStudio.setState({
      ...slot(master, master),
      clips: [clip("master", "done"), clip("target", "done")],
      activeClipId: "master",
    });
    vi.mocked(aiStatus).mockResolvedValueOnce({ available: true, allowed: true });
    vi.mocked(checkAgainstScript).mockResolvedValueOnce([{ from: 2, to: 3, text: "CMO" }]);

    await useStudio.getState().applyMasterToAll(["target"]);

    // the AI saw only the unplaced fix with its master context
    expect(vi.mocked(checkAgainstScript).mock.calls[0][0]).toBe("and the CMO needs my help");
    expect(getClipSnapshot("target")!.words.map((w) => w.text)).toEqual([
      "and", "my", "CMO", "needs", "help",
    ]);
    expect(useStudio.getState().scriptFixes.target).toEqual([
      expect.objectContaining({ before: "c m", after: "CMO", from: "master" }),
    ]);
  });
});
