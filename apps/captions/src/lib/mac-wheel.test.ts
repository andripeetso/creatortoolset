// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { watchWheelPlaces } from "./mac-wheel";

const webkit = (w: Window) => w as unknown as { webkit?: unknown };

afterEach(() => {
  delete webkit(window).webkit;
  document.body.innerHTML = "";
});

it("tells the Mac app the kind of place under the pointer, only when it changes", () => {
  // a fresh window per test, so listeners from another test never answer
  const win = new EventTarget() as unknown as Window;
  const postMessage = vi.fn();
  webkit(win).webkit = { messageHandlers: { wheel: { postMessage } } };
  document.body.innerHTML = `<p id="text">words</p><div data-wheel="snap"><canvas id="canvas"></canvas></div>`;
  watchWheelPlaces(win);
  const over = (id: string, type = "pointerover") => {
    const e = new Event(type);
    Object.defineProperty(e, "target", { value: document.getElementById(id) });
    win.dispatchEvent(e);
  };
  over("text");
  over("text");
  over("canvas");
  over("canvas", "wheel");
  over("text", "wheel");
  expect(postMessage.mock.calls).toEqual([["glide"], ["snap"], ["glide"]]);
});

it("adds nothing in a plain browser", () => {
  const add = vi.spyOn(window, "addEventListener");
  watchWheelPlaces(window);
  expect(add).not.toHaveBeenCalled();
});
