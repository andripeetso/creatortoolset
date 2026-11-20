// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StopsBar } from "./Inspector";

// A gradient stop dragged along its strip lets go of the window when the drag ends any way: the pointer up, the
// pointer taken away (a touch turned into a scroll, a system gesture), or the strip gone mid-drag (its popover closed).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = undefined;
});

const stops = [
  { at: 0, color: "#ffffff" },
  { at: 1, color: "#000000" },
];
const bar = (onSet: () => void) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<StopsBar stops={stops} picked={0} onPick={() => {}} onSet={onSet} />));
  act(() => void host!.querySelector("button")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 10 })));
};
const moveOnWindow = () => act(() => void window.dispatchEvent(new PointerEvent("pointermove", { clientX: 20 })));

it("moves a stop while it is dragged, and no more once the pointer is cancelled", () => {
  const onSet = vi.fn();
  bar(onSet);
  moveOnWindow();
  expect(onSet).toHaveBeenCalledTimes(1);
  act(() => void window.dispatchEvent(new PointerEvent("pointercancel")));
  moveOnWindow();
  expect(onSet).toHaveBeenCalledTimes(1);
});

it("lets go of the window when the strip goes mid-drag", () => {
  const onSet = vi.fn();
  bar(onSet);
  act(() => root!.unmount());
  root = undefined;
  moveOnWindow();
  expect(onSet).not.toHaveBeenCalled();
});
