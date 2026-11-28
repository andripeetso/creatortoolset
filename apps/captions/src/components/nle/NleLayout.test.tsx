// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NleLayout, Panel } from "./NleLayout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

const shows = (label: string) => !host.querySelector(`section[aria-label="${label}"]`)!.parentElement!.className.includes("hidden");
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

function render(props: Partial<Parameters<typeof NleLayout>[0]> = {}) {
  let fullSeen = false;
  act(() => {
    root.render(
      <NleLayout
        media={<Panel title="Media Pool"><div /></Panel>}
        viewer={<Panel title="Viewer"><div /></Panel>}
        inspector={<Panel title="Inspector"><div /></Panel>}
        timeline={(full) => {
          fullSeen = full;
          return <Panel title="Timeline"><div data-full={String(full)} /></Panel>;
        }}
        {...props}
      />,
    );
  });
  return () => fullSeen;
}

describe("NleLayout", () => {
  it("in chat mode with a side panel (AI draft), hides side panels by default and shows explicit Media Pool, Inspector and All editing tools toggles", () => {
    const isFull = render({ chat: { bar: <span>Draft 1</span> }, side: <div aria-label="Takes" /> });
    expect(shows("Media Pool")).toBe(false);
    expect(shows("Inspector")).toBe(false);
    expect(isFull()).toBe(false);

    const mediaBtn = button("Media Pool")!;
    const inspectorBtn = button("Inspector")!;
    const allBtn = button("All editing tools")!;
    expect(mediaBtn.getAttribute("aria-pressed")).toBe("false");
    expect(inspectorBtn.getAttribute("aria-pressed")).toBe("false");
    expect(allBtn.getAttribute("aria-pressed")).toBe("false");

    // opening Media Pool alone makes full timeline tools available
    act(() => mediaBtn.click());
    expect(shows("Media Pool")).toBe(true);
    expect(shows("Inspector")).toBe(false);
    expect(mediaBtn.getAttribute("aria-pressed")).toBe("true");
    expect(inspectorBtn.getAttribute("aria-pressed")).toBe("false");
    expect(isFull()).toBe(true);

    // opening Inspector independently
    act(() => inspectorBtn.click());
    expect(shows("Inspector")).toBe(true);
    expect(inspectorBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("in chat mode without a side panel (manual timeline), opens Media Pool and full timeline tools by default", () => {
    const isFull = render({ chat: { bar: <span>Manual</span> } });
    expect(shows("Media Pool")).toBe(true);
    expect(shows("Inspector")).toBe(false);
    expect(isFull()).toBe(true);
    expect(button("Media Pool")!.getAttribute("aria-pressed")).toBe("true");
    expect(button("Inspector")!.getAttribute("aria-pressed")).toBe("false");

    // explicitly hiding Media Pool persists under the manual key and turns off full mode
    act(() => button("Media Pool")!.click());
    expect(shows("Media Pool")).toBe(false);
    expect(isFull()).toBe(false);
    expect(JSON.parse(localStorage.getItem("ct-nle-panels-chat-manual")!)).toEqual({ media: false, inspector: false });
  });

  it("toggling panels on an AI draft does not hide Media Pool on a manual timeline", () => {
    render({ chat: { bar: <span>Draft 1</span> }, side: <div aria-label="Takes" /> });
    act(() => button("Inspector")!.click());
    expect(JSON.parse(localStorage.getItem("ct-nle-panels-chat")!)).toEqual({ media: false, inspector: true });

    // unmount and mount a manual timeline: Media Pool still opens by default
    act(() => root.unmount());
    root = createRoot(host);
    const isFull = render({ chat: { bar: <span>Manual</span> } });
    expect(shows("Media Pool")).toBe(true);
    expect(shows("Inspector")).toBe(false);
    expect(isFull()).toBe(true);
  });

  it("outside chat mode, opens both panels with the Panels toolbar", () => {
    const isFull = render({ chat: null });
    expect(host.querySelector('[role="toolbar"][aria-label="Panels"]')).not.toBeNull();
    expect(shows("Media Pool")).toBe(true);
    expect(shows("Inspector")).toBe(true);
    expect(isFull()).toBe(true);
  });
});
