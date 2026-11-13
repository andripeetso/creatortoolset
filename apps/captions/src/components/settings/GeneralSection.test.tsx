import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScreenRecording, ThisComputer } from "./GeneralSection";
import { Dictation } from "./DictationSettings";
import type { DictationState, ThisMacState } from "./ThisMacSection";

const state = (over: Partial<ThisMacState> = {}) => ({ answer: "", aiOn: true, running: 0, lastError: null, notice: null, paired: true, problem: null, servers: [], ...over }) as ThisMacState;

describe("the recording shortcut row", () => {
  it("is not shown outside the Mac app, or in one too old to report the shortcut", () => {
    expect(renderToStaticMarkup(<ScreenRecording mac={null} />)).toBe("");
    expect(renderToStaticMarkup(<ScreenRecording mac={state()} />)).toBe("");
  });

  it("shows the shortcut as its status, with Change", () => {
    const html = renderToStaticMarkup(<ScreenRecording mac={state({ shortcut: "⌥⇧R" })} />);
    expect(html).toContain("Screen recording");
    expect(html).toContain("Recording shortcut");
    expect(html).toContain("⌥⇧R");
    expect(html).toContain(">Change</button>");
  });

  it("says Off when no shortcut is set", () => {
    expect(renderToStaticMarkup(<ScreenRecording mac={state({ shortcut: "" })} />)).toContain(">Off</div>");
  });
});

describe("the version row", () => {
  it("shows the Mac app's version, and nothing outside the Mac app or in one too old to say", () => {
    expect(renderToStaticMarkup(<ThisComputer version="0.15.20" />)).toContain("Creator Toolset 0.15.20");
    expect(renderToStaticMarkup(<ThisComputer />)).not.toContain("Version");
  });
});

const dictation = (over: Partial<DictationState> = {}): DictationState => ({
  on: true,
  keys: { talk: "Hold fn", history: "", file: "", cancel: "F16" },
  picking: null,
  model: "whisper-large-v3-turbo",
  models: [
    { id: "whisper-large-v3-turbo", name: "Whisper Large v3 Turbo", size: "1.6 GB", here: true, removable: false, progress: null },
    { id: "whisper-base.en", name: "Whisper Base (English)", size: "145 MB", here: false, removable: false, progress: null },
  ],
  keep: 10,
  sounds: true,
  needs: null,
  ...over,
});

describe("the dictation group", () => {
  it("is not shown outside the Mac app, or in one too old to have dictation", () => {
    expect(renderToStaticMarkup(<Dictation mac={null} />)).toBe("");
    expect(renderToStaticMarkup(<Dictation mac={state()} />)).toBe("");
  });

  it("names what the keys do and shows each setting", () => {
    const html = renderToStaticMarkup(<Dictation mac={state({ dictation: dictation() })} />);
    for (const text of ["Talk", "Hold fn", "F16", ">Choose</button>", "Transcribe a file", "Set up dictation", "Speech model", "Sounds when it starts and stops", ">Open</button>"]) {
      expect(html).toContain(text);
    }
    // a model already on this Mac that this app did not download: neither Download nor Remove
    expect(html).not.toContain(">Download</button>");
    expect(html).not.toContain(">Remove</button>");
    expect(html).not.toContain("Needs");
  });

  it("offers Download for a model not here, its progress while it downloads, and Remove for its own", () => {
    const base = (m: Partial<DictationState["models"][number]>) => dictation({ model: "whisper-base.en", models: [{ ...dictation().models[1], ...m }] });
    expect(renderToStaticMarkup(<Dictation mac={state({ dictation: base({}) })} />)).toContain(">Download</button>");
    const busy = renderToStaticMarkup(<Dictation mac={state({ dictation: base({ progress: 0.42 }) })} />);
    expect(busy).toContain("Downloading · 42%");
    expect(busy).not.toContain(">Download</button>");
    expect(renderToStaticMarkup(<Dictation mac={state({ dictation: base({ here: true, removable: true }) })} />)).toContain(">Remove</button>");
  });

  it("says which permission is missing, next to the setup guide", () => {
    const html = renderToStaticMarkup(<Dictation mac={state({ dictation: dictation({ needs: "Accessibility" }) })} />);
    expect(html).toContain("Needs Accessibility");
    expect(html).toContain(">Set up dictation</button>");
  });

  it("says in one line why the keys are off while another dictation app is open", () => {
    const html = renderToStaticMarkup(<Dictation mac={state({ dictation: dictation({ needs: "Accessibility", paused: "Off while your earlier dictation app is open" }) })} />);
    expect(html).toContain("Off while your earlier dictation app is open");
    expect(html).not.toContain("Needs");
  });

  it("asks for a key while the app waits for one", () => {
    const html = renderToStaticMarkup(<Dictation mac={state({ dictation: dictation({ picking: "history" }) })} />);
    expect(html).toContain("Press a key…");
  });

  it("shows only the switch while dictation is off", () => {
    const html = renderToStaticMarkup(<Dictation mac={state({ dictation: dictation({ on: false, needs: "Microphone" }) })} />);
    expect(html).toContain("Dictation");
    expect(html).not.toContain("Hold fn");
    expect(html).not.toContain("Needs");
  });
});
