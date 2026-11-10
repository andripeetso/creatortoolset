import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScreenRecording } from "./GeneralSection";
import type { ThisMacState } from "./ThisMacSection";

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
