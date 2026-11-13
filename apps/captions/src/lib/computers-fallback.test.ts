import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./audio", () => ({ extractAudio: vi.fn() }));
// the page's own model, as it answers in a browser
vi.mock("./transcribe", async (original) => ({
  ...(await original<typeof import("./transcribe")>()),
  transcribeAudio: vi.fn(() => ({ promise: Promise.resolve([{ id: 0, text: "browser", start: 0, end: 0.5, timing: "approximate" }]), cancel: () => {} })),
}));

import { enqueueTranscription, loadClipSlots, useStudio } from "./store";
import { CLOUD_MODEL_ID, cloudStatus, transcribeAudio } from "./transcribe";
import { DEFAULT_STYLE } from "./types";

const ID = "clip-computers";

function seed(): void {
  loadClipSlots([[ID, {
    words: [], cues: [], originalWords: null, style: DEFAULT_STYLE, posSegments: [], texts: [], cadenceApplied: false,
    cadenceFit: null, cadenceDirty: false, done: false, peaks: null, pcm: new Float32Array(16000), file: null,
  }]]);
  useStudio.setState({
    projectId: "p", model: CLOUD_MODEL_ID, autoCadence: false, script: "", activeClipId: ID, words: [], cues: [], status: { phase: "idle" },
    clips: [{ id: ID, name: "clip.mp4", videoUrl: "blob:x", duration: 1, sourceWidth: 1080, sourceHeight: 1920, srcFps: 30, status: { phase: "idle" },
      transcribed: false, uploadState: "local", uploadPct: 0, uploadError: null, hasOriginal: false, originalBytes: 0, done: false }],
  });
}

/** The server: on the person's computers (`available` says so), and what POST /api/transcribe answers. */
function server(answer: () => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/transcribe/available") return Response.json({ available: true, allowed: true, computers: "Whisper large-v3 turbo" });
    if (url.startsWith("/api/transcribe")) return answer();
    throw new Error(`Unexpected fetch: ${url}`);
  }));
}

const landed = () => vi.waitFor(() => expect(useStudio.getState().words.length).toBeGreaterThan(0), { timeout: 5000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  loadClipSlots([]);
  useStudio.setState({ clips: [], activeClipId: null, words: [], cues: [], status: { phase: "idle" }, transcribeNote: null });
});

describe("captions on the person's computers, from the page", () => {
  it("their computers answer: those words, no note", async () => {
    server(() => Response.json({ words: [{ text: "computer", start: 0.1, end: 0.4 }], language: "en" }));
    await cloudStatus();
    seed();
    enqueueTranscription([ID]);
    await landed();
    expect(useStudio.getState().words.map((w) => [w.text, w.start, w.end])).toEqual([["computer", 0.1, 0.4]]);
    expect(useStudio.getState().transcribeNote).toBeNull();
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("the server wrote them with Deepgram: its note is shown", async () => {
    server(() => Response.json({ words: [{ text: "deepgram", start: 0, end: 1 }], language: "en", note: "Your computers are off: written by Deepgram" }));
    seed();
    enqueueTranscription([ID]);
    await landed();
    expect(useStudio.getState().transcribeNote).toEqual({ text: "Your computers are off: written by Deepgram" });
  });

  it("nothing on the server can (no key), or the request never came back: the browser's model writes them", async () => {
    server(() => Response.json({ error: "Your computers are off", code: "USE_BROWSER", why: "Your computers are off" }, { status: 503 }));
    seed();
    enqueueTranscription([ID]);
    await landed();
    expect(useStudio.getState().words.map((w) => w.text)).toEqual(["browser"]);
    expect(useStudio.getState().transcribeNote).toEqual({ text: "Your computers are off: written in this browser" });

    server(() => new Response("Gateway Timeout", { status: 504 }));
    useStudio.setState({ words: [], transcribeNote: null });
    seed();
    enqueueTranscription([ID]);
    await landed();
    expect(useStudio.getState().transcribeNote).toEqual({ text: "Your computers did not answer: written in this browser" });
  });
});
