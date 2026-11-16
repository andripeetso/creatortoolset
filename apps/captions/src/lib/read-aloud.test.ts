import { describe, expect, it, vi } from "vitest";
import { speak, spoken, stopSpeaking, unlockAudio } from "./read-aloud";

describe("spoken", () => {
  it("reads a reply's words, not its marks", () => {
    expect(spoken("Open [the first one](https://example.com/r/1) and **check the hook**.")).toBe("Open the first one and check the hook.");
    expect(spoken("Here:\n```\nnpm run dev\n```\nDone")).toBe("Here:\n \nDone");
    expect(spoken("- one\n- two")).toBe("one\ntwo");
    expect(spoken("See https://example.com now")).toBe("See now");
  });
});

describe("the local voice dying", () => {
  it("after Stop, the computer's voice does not read the reply that was stopped", () => {
    const made: { onerror: null | (() => void) }[] = [];
    vi.stubGlobal("Worker", class {
      onerror: null | (() => void) = null;
      constructor() {
        made.push(this);
      }
      postMessage() {}
    });
    vi.stubGlobal("AudioContext", class {
      state = "running";
    });
    const said = vi.fn();
    vi.stubGlobal("window", { speechSynthesis: true });
    vi.stubGlobal("speechSynthesis", { cancel: () => {}, speak: said, getVoices: () => [] });
    vi.stubGlobal("SpeechSynthesisUtterance", class {});
    unlockAudio();
    speak("Hello there");
    stopSpeaking();
    made[0]!.onerror!();
    expect(said).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
