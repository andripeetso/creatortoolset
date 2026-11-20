// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Design, TextLayer } from "@contracts/design";

// Design's text panel on one text layer, outside the Designer (the video editor's Inspector on a text clip): a change
// made in it comes back as the layer changed.

// the same list each time: a new one is a change the page draws again for
const noFonts = vi.hoisted(() => [] as never[]);
vi.mock("@/lib/design/own-fonts", async (real) => ({ ...(await real<typeof import("@/lib/design/own-fonts")>()), useOwnFonts: () => noFonts }));
const { TextSection } = await import("./Inspector");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = undefined;
});

const design = { id: "d1", pictures: [] } as unknown as Design;
const layer: TextLayer = { id: "t1", type: "text", text: "Big news", font: "Inter", size: 96, color: "#ffffff", align: "left", x: 0, y: 0, w: 800, h: 200, runs: [{ start: 4, end: 8, color: "#ff0000" }] };

function mount(l: TextLayer, onChange: (l: TextLayer, merge?: string) => void) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<TextSection layer={l} design={design} onChange={onChange} />));
}

it("sets the alignment, and the words with their runs following them", () => {
  const onChange = vi.fn();
  mount(layer, onChange);
  for (const s of ["Typography", "Fill", "Stroke", "Highlight", "Effects"]) expect(host!.textContent).toContain(s);
  act(() => host!.querySelector<HTMLButtonElement>('[aria-label="Text align centre"]')!.click());
  expect(onChange).toHaveBeenLastCalledWith({ ...layer, align: "center" }, undefined);

  // typed at the start: the red run moves along with its word
  const words = host!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Words"]')!;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    set.call(words, "Very big news");
    words.setSelectionRange(5, 5);
    words.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const [typed, merge] = onChange.mock.lastCall!;
  expect(merge).toBe("words");
  expect(typed.text).toBe("Very big news");
  expect(typed.runs).toEqual([{ start: 9, end: 13, color: "#ff0000" }]);
});

it("adds a highlighter stroke behind the words", () => {
  const onChange = vi.fn();
  mount(layer, onChange);
  act(() => host!.querySelector<HTMLButtonElement>('[aria-label="Add a highlight"]')!.click());
  expect(onChange.mock.lastCall![0].marks).toEqual([{ color: "#f2b63c" }]);
});
