import { afterEach, describe, expect, it, vi } from "vitest";

// the browser's model, as it answers in a browser
vi.mock("./transcribe", async (original) => ({
  ...(await original<typeof import("./transcribe")>()),
  transcribeAudio: vi.fn(() => ({ promise: Promise.resolve([{ id: 0, text: "from the browser", start: 0, end: 0.5, timing: "approximate" }]), cancel: () => {} })),
}));

import { transcribeAudio } from "./transcribe";
import { writeDown } from "./voice-input";

const server = (res: Response) => vi.stubGlobal("fetch", vi.fn(async () => res));
const recording = new Blob([new Uint8Array(8)], { type: "audio/webm" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the dock's mic when the person's computers can't", () => {
  it("the server's note comes along with its words", async () => {
    server(Response.json({ text: "Hello.", language: "en", note: "Your computers are busy: written by Deepgram" }));
    expect(await writeDown(recording, () => {})).toEqual({ text: "Hello.", language: "en", note: "Your computers are busy: written by Deepgram" });
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("no key either: the browser writes it, and says why", async () => {
    vi.stubGlobal("OfflineAudioContext", class {
      decodeAudioData = async () => ({ getChannelData: () => new Float32Array(16000) });
    });
    server(Response.json({ error: "Your computers are off. Needs a Deepgram key", code: "NEEDS_KEY", chosen: false, why: "Your computers are off" }, { status: 402 }));
    expect(await writeDown(recording, () => {})).toEqual({ text: "from the browser", note: "Your computers are off: written in the browser" });
  });

  it("an engine the person picked that can't run says what it needs", async () => {
    server(Response.json({ error: "Needs a Deepgram key", code: "NEEDS_KEY", chosen: true }, { status: 402 }));
    await expect(writeDown(recording, () => {})).rejects.toThrow("Needs a Deepgram key");
    expect(transcribeAudio).not.toHaveBeenCalled();
  });
});
