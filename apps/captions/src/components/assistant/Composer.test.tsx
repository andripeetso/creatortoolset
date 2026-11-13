// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DictationState } from "@/components/settings/ThisMacSection";
import { Composer } from "./Composer";
import { EMPTY_DRAFT } from "./draft";

// The message box's mic: records in a browser, and in the Mac app it is the way into the Mac's own dictation, gone once
// that is set up and on.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const sent: string[] = [];
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  sent.length = 0;
  delete document.documentElement.dataset.macThisMac;
  delete (window as { webkit?: unknown }).webkit;
});

/** The composer, in the Mac app when `dictation` is given (undefined: an app that reports none), in a browser otherwise. */
function render(dictation?: Partial<DictationState> | "none") {
  if (dictation) {
    document.documentElement.dataset.macThisMac = "1";
    (window as { webkit?: unknown }).webkit = { messageHandlers: { window: { postMessage: (m: string) => sent.push(m) } } };
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const noop = () => {};
  act(() => root!.render(<Composer draft={EMPTY_DRAFT} setDraft={noop} onSend={noop} onStop={noop} onFiles={noop} onPaste={() => false} quote={null} onDropQuote={noop} waiting={false} />));
  if (dictation) {
    const detail = dictation === "none" ? {} : { dictation: { on: true, paused: null, ...dictation } };
    act(() => void window.dispatchEvent(new CustomEvent("mac-this", { detail })));
  }
  return host;
}
const mic = () => host!.querySelector<HTMLButtonElement>('button[aria-label="Talk instead of typing"], button[aria-label="Dictation, in any app"]');

it("in a browser the mic records, as before", () => {
  render();
  expect(mic()?.getAttribute("aria-label")).toBe("Talk instead of typing");
});

it("in a Mac app without dictation the mic records, as before", () => {
  render("none");
  expect(mic()?.getAttribute("aria-label")).toBe("Talk instead of typing");
});

it("in a Mac app too old to say whether dictation is set up, the mic records, as before (it has the old guide)", () => {
  render({});
  expect(mic()?.getAttribute("aria-label")).toBe("Talk instead of typing");
});

it("in the Mac app with dictation set up and on, there is no mic: the talk key types into the box", () => {
  render({ setUp: true });
  expect(mic()).toBeNull();
  // the earlier dictation app is open and types for them
  act(() => root!.unmount());
  render({ setUp: false, paused: "Off while your earlier dictation app is open" });
  expect(mic()).toBeNull();
});

it("in the Mac app not set up (or switched off), a click opens dictation's setup", () => {
  vi.useFakeTimers();
  try {
    for (const d of [{ setUp: false }, { setUp: true, on: false }]) {
      render(d);
      expect(mic()?.getAttribute("aria-label")).toBe("Dictation, in any app");
      sent.length = 0;
      act(() => mic()!.click());
      expect(sent).toEqual(["thismac-dictation:guide"]);
      // it asks again until the setup is done
      act(() => void vi.advanceTimersByTime(3000));
      expect(sent).toContain("thismac-state");
      act(() => root!.unmount());
      host!.remove();
    }
  } finally {
    vi.useRealTimers();
  }
  root = undefined;
});
