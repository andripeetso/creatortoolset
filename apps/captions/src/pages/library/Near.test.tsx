// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Near, nearView } from "./Near";

afterEach(() => vi.unstubAllGlobals());

it("counts a box within one and a half screens of view as near", () => {
  expect(nearView(0, 100, 1000)).toBe(true);
  expect(nearView(2400, 2500, 1000)).toBe(true);
  expect(nearView(2600, 2700, 1000)).toBe(false);
  expect(nearView(-1600, -1501, 1000)).toBe(false);
});

it("draws a clip only while it is near, and an empty box of its shape elsewhere", () => {
  let report: (seen: { target: Element; isIntersecting: boolean }[]) => void = () => {};
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: typeof report) {
        report = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // the test page lays nothing out: every box is at 0,0, so put this one far below
  const far = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 9000, bottom: 9100 } as DOMRect);
  const draw = vi.fn(() => <span>clip</span>);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(<Near size={{ aspectRatio: "3 / 4" }}>{draw}</Near>));
  const place = host.firstChild as HTMLElement;
  expect(host.textContent).toBe("");
  expect(draw).not.toHaveBeenCalled();
  expect(place.style.aspectRatio).toBe("3 / 4");
  act(() => report([{ target: place, isIntersecting: true }]));
  expect(host.textContent).toBe("clip");
  act(() => report([{ target: place, isIntersecting: false }]));
  expect(host.textContent).toBe("");
  act(() => root.unmount());
  host.remove();
  far.mockRestore();
});
