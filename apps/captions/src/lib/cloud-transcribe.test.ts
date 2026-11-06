import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./audio", () => ({
  extractAudio: vi.fn(async () => ({
    pcm: new Float32Array(16000),
    peaks: new Float32Array(64),
    duration: 1,
  })),
}));

import { extractAudio } from "./audio";
import {
  enqueueTranscription,
  loadClipSlots,
  useStudio,
  type ClipInfo,
  type ClipSnapshot,
} from "./store";
import { CLOUD_MODEL_ID } from "./transcribe";
import { DEFAULT_STYLE } from "./types";

const CLIP_ID = "clip-cloud-regression";

function slot(pcm: Float32Array | null): ClipSnapshot {
  return {
    words: [],
    cues: [],
    originalWords: null,
    style: DEFAULT_STYLE,
    posSegments: [],
    texts: [],
    cadenceApplied: false,
    cadenceFit: null,
    cadenceDirty: false,
    done: false,
    peaks: null,
    pcm,
    file: new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" }),
  };
}

function stuckUploadClip(): ClipInfo {
  return {
    id: CLIP_ID,
    name: "clip.mp4",
    videoUrl: "blob:local",
    duration: 1,
    sourceWidth: 1080,
    sourceHeight: 1920,
    srcFps: 30,
    status: { phase: "idle" },
    transcribed: false,
    // The source upload NEVER advances — the exact production deadlock.
    uploadState: "local",
    uploadPct: 0,
    uploadError: null,
    hasOriginal: false,
    originalBytes: 0,
    done: false,
  };
}

function seedStudio(pcm: Float32Array | null): void {
  loadClipSlots([[CLIP_ID, slot(pcm)]]);
  useStudio.setState({
    projectId: "project-1",
    fileName: "clip",
    model: CLOUD_MODEL_ID,
    autoCadence: false,
    clips: [stuckUploadClip()],
    activeClipId: CLIP_ID,
    videoUrl: "blob:local",
    words: [],
    cues: [],
    style: DEFAULT_STYLE,
    posSegments: [],
    texts: [],
    status: { phase: "idle" },
    duration: 1,
    sourceWidth: 1080,
    sourceHeight: 1920,
    videoWidth: 1080,
    videoHeight: 1920,
  });
}

interface FetchCall {
  url: string;
  contentType: string | null;
  body: BodyInit | null | undefined;
}

function stubCloudFetch(): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        contentType: headers.get("Content-Type"),
        body: init?.body,
      });
      if (url === "/api/transcribe") {
        return new Response(
          JSON.stringify({
            words: [{ text: "hello", start: 0, end: 0.5 }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

describe("cloud transcription without a finished source upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    loadClipSlots([]);
    useStudio.setState({
      clips: [],
      activeClipId: null,
      videoUrl: null,
      words: [],
      cues: [],
      status: { phase: "idle" },
    });
  });

  it("completes from a cached PCM while the upload never advances", async () => {
    seedStudio(new Float32Array(16000));
    const calls = stubCloudFetch();

    enqueueTranscription([CLIP_ID]);
    await vi.waitFor(
      () => {
        expect(useStudio.getState().words).toHaveLength(1);
      },
      { timeout: 5000 },
    );

    const cloudCall = calls.find((call) => call.url === "/api/transcribe");
    expect(cloudCall).toBeDefined();
    expect(cloudCall?.contentType).toBe("audio/wav");
    expect(calls.some((c) => c.url.includes("/transcribe/project/"))).toBe(
      false,
    );
    // WAV payload: RIFF header, not the multi-hundred-megabyte source video
    const bytes = new Uint8Array(await (cloudCall!.body as Blob).arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    // the stuck upload is untouched — transcription never gated on it
    expect(useStudio.getState().clips[0].uploadState).toBe("local");
    expect(extractAudio).not.toHaveBeenCalled();
  });

  it("extracts audio in the worker and sends the WAV, still without the upload", async () => {
    seedStudio(null);
    const calls = stubCloudFetch();

    enqueueTranscription([CLIP_ID]);
    await vi.waitFor(
      () => {
        expect(useStudio.getState().words).toHaveLength(1);
      },
      { timeout: 5000 },
    );

    expect(extractAudio).toHaveBeenCalledOnce();
    const cloudCall = calls.find((call) => call.url === "/api/transcribe");
    expect(cloudCall).toBeDefined();
    expect(calls.some((c) => c.url.includes("/transcribe/project/"))).toBe(
      false,
    );
    expect(useStudio.getState().clips[0].uploadState).toBe("local");
  });
});
