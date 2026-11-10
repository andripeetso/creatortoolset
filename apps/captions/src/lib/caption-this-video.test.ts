import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./audio", () => ({
  extractAudio: vi.fn(async () => ({ pcm: new Float32Array(16000), peaks: new Float32Array(64), duration: 1 })),
}));
vi.mock("./transcribe", async (original) => ({
  ...(await original<typeof import("./transcribe")>()),
  detectDevice: vi.fn(async () => "wasm"),
  persistEngine: vi.fn(),
  transcribeAudio: vi.fn(() => ({
    promise: Promise.resolve([{ id: 0, text: "hello", start: 0, end: 0.5, timing: "approximate" }]),
    cancel: () => {},
  })),
}));

import { captionThisVideo, useStudio } from "./store";
import { FIRST_JOB_MODEL, persistEngine, transcribeAudio } from "./transcribe";

const video = (name: string) => new File([new Uint8Array(8)], name, { type: "video/mp4" });

describe("captionThisVideo", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("leaves everything alone for a file that isn't a video", () => {
    const before = useStudio.getState();
    expect(captionThisVideo(new File(["x"], "notes.txt", { type: "text/plain" }))).toBe(false);
    expect(useStudio.getState()).toBe(before);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("opens the video and transcribes it on this device with nothing to press", async () => {
    const fetched = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetched);
    expect(captionThisVideo(video("Tiny Acrobatics intro.MP4"))).toBe(true);

    const now = useStudio.getState();
    expect(now.setupPending).toBe(false); // no dialog
    expect(now.status.phase).toBe("extracting"); // busy at once: no Transcribe button
    expect(now.fileName).toBe("Tiny Acrobatics intro");
    expect(now.clips).toHaveLength(1);

    await vi.waitFor(() => expect(useStudio.getState().status.phase).toBe("done"));
    expect(vi.mocked(transcribeAudio).mock.calls[0].slice(1, 4)).toEqual([FIRST_JOB_MODEL, null, "wasm"]);
    expect(useStudio.getState().words.map((w) => w.text)).toEqual(["hello"]);
    expect(useStudio.getState().cues.length).toBeGreaterThan(0);
    // this run's model only: a person's own engine choice is never written
    expect(persistEngine).not.toHaveBeenCalled();
    // the words are the end: no AI pass is asked for after them
    expect(useStudio.getState().autoCadence).toBe(false);
    expect(fetched).not.toHaveBeenCalled();
  });
});
