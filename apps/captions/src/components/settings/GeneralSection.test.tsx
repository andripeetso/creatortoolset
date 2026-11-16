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
    for (const text of ["Talk", "Hold fn", "F16", ">Choose key</button>", "Transcribe a file", ">Open setup</button>", "Speech model", "Sound cues", ">Open</button>"]) {
      expect(html).toContain(text);
    }
    // every model is listed with what it is good at; the chosen one, on this Mac, is In use
    expect(html).toContain("Most accurate · every language · 1.6 GB");
    expect(html).toContain("In use");
    // one already on this Mac that this app did not download has no menu to remove it; one not here can be downloaded
    expect(html).not.toContain(": more");
    expect(html).toContain('aria-label="Download Whisper Base (English)"');
    expect(html).not.toContain(">Use</button>");
    expect(html).not.toContain("Needs");
  });

  it("offers Download for a model not here, its progress while it downloads, and Remove for its own", () => {
    const base = (m: Partial<DictationState["models"][number]>) => dictation({ model: "whisper-base.en", models: [{ ...dictation().models[1], ...m }] });
    const missing = renderToStaticMarkup(<Dictation mac={state({ dictation: base({}) })} />);
    expect(missing).toContain(">Download</button>");
    expect(missing).toContain("Chosen, not on this Mac yet");
    expect(missing).not.toContain("In use");
    const busy = renderToStaticMarkup(<Dictation mac={state({ dictation: base({ progress: 0.42 }) })} />);
    expect(busy).toContain("Downloading · 42%");
    expect(busy).not.toContain(">Download</button>");
    const own = renderToStaticMarkup(<Dictation mac={state({ dictation: base({ here: true, removable: true }) })} />);
    expect(own).toContain("In use");
    expect(own).toContain('aria-label="Whisper Base (English): more"');
  });

  it("offers Use for a model on this Mac that isn't the chosen one, and one download at a time", () => {
    const [turbo, small] = dictation().models;
    const html = renderToStaticMarkup(<Dictation mac={state({ dictation: dictation({ model: "whisper-base.en", models: [turbo, { ...small, here: true }] }) })} />);
    expect(html).toContain('aria-label="Use Whisper Large v3 Turbo"');
    const busy = renderToStaticMarkup(<Dictation mac={state({ dictation: dictation({ models: [{ ...turbo, here: false, progress: 0.1 }, small] }) })} />);
    expect(busy).toMatch(/aria-label="Download Whisper Base \(English\)"[^>]*disabled/);
  });

  it("says when the speech server doesn't answer, and what happens to a dictation then", () => {
    const server = "http://tiny-acrobatics.example:7886/api/transcribe";
    // answering, or not checked yet (or an older app): nothing to say
    for (const serverAnswers of [true, null, undefined]) {
      expect(renderToStaticMarkup(<Dictation mac={state({ dictation: dictation({ server, serverAnswers }) })} />)).not.toContain("Not answering");
    }
    // the chosen model (Turbo) is on this Mac: it transcribes
    expect(renderToStaticMarkup(<Dictation mac={state({ dictation: dictation({ server, serverAnswers: false }) })} />)).toContain("Not answering · this Mac transcribes for now");
    // the chosen model isn't here: nothing downloads by itself, the recording waits
    expect(renderToStaticMarkup(<Dictation mac={state({ dictation: dictation({ server, serverAnswers: false, model: "whisper-base.en" }) })} />)).toContain("Not answering · recordings wait in History");
  });

  it("offers Cancel on a running download where the app can stop one, and says its size", () => {
    const [turbo, small] = dictation().models;
    const models = [turbo, { ...small, progress: 0.25 }];
    const html = renderToStaticMarkup(<Dictation mac={state({ dictation: dictation({ models, cancel: true }) })} />);
    expect(html).toContain("Downloading · 25% of 145 MB");
    expect(html).toContain('aria-label="Cancel the download of Whisper Base (English)"');
    // an older app can't stop one: no button that does nothing
    expect(renderToStaticMarkup(<Dictation mac={state({ dictation: dictation({ models }) })} />)).not.toContain(">Cancel</button>");
  });

  it("says which permission is missing, next to Set up", () => {
    const html = renderToStaticMarkup(<Dictation mac={state({ dictation: dictation({ needs: "Accessibility" }) })} />);
    expect(html).toContain("Needs Accessibility");
    expect(html).toContain(">Open setup</button>");
  });

  it("says in one line why the keys are off while another dictation app is open", () => {
    const html = renderToStaticMarkup(<Dictation mac={state({ dictation: dictation({ needs: "Accessibility", paused: "Off while your earlier dictation app is open" }) })} />);
    expect(html).toContain("Off while your earlier dictation app is open");
    expect(html).not.toContain("Needs");
  });

  it("shows the speech server's address where the app has one, and not with the server's engine", () => {
    expect(renderToStaticMarkup(<Dictation mac={state({ dictation: dictation() })} />)).not.toContain("Speech server");
    const html = renderToStaticMarkup(<Dictation mac={state({ dictation: dictation({ server: "http://tiny-acrobatics.example:7886/api/transcribe" }) })} />);
    expect(html).toContain("Speech server");
    expect(html).toContain("Used when your server doesn&#x27;t answer.");
    expect(html).toContain('value="http://tiny-acrobatics.example:7886/api/transcribe"');
    expect(renderToStaticMarkup(<Dictation mac={state({ dictation: dictation({ server: "", engine: "server" }) })} />)).not.toContain("Speech server");
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
