// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { watchWheelPlaces } from "./mac-wheel";

const webkit = (w: Window) => w as unknown as { webkit?: unknown };

afterEach(() => {
  vi.restoreAllMocks();
  delete webkit(window).webkit;
  document.body.innerHTML = "";
});

it("tells the Mac app the kind of place under the pointer, only when it changes", () => {
  // a fresh window per test, so listeners from another test never answer
  const win = new EventTarget() as unknown as Window;
  const postMessage = vi.fn();
  webkit(win).webkit = { messageHandlers: { wheel: { postMessage } } };
  Object.assign(win, { document });
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

it("looks again under a still pointer when the page changes, so the first wheel step goes the new way", async () => {
  const win = new EventTarget() as unknown as Window;
  const postMessage = vi.fn();
  webkit(win).webkit = { messageHandlers: { wheel: { postMessage } } };
  Object.assign(win, { document });
  document.body.innerHTML = `<p id="text">words</p>`;
  // what lies under the pointer: the canvas once it is there
  vi.spyOn(document, "elementFromPoint").mockImplementation(() => document.querySelector("canvas") ?? document.getElementById("text"));
  watchWheelPlaces(win);
  const pointer = (type: string) => {
    const e = Object.assign(new Event(type), { clientX: 30, clientY: 40 });
    Object.defineProperty(e, "target", { value: document.getElementById("text") });
    win.dispatchEvent(e);
  };
  pointer("pointerover");
  pointer("pointermove");
  document.body.insertAdjacentHTML("beforeend", `<div data-wheel="snap"><canvas></canvas></div>`);   // a new route's canvas
  await vi.waitFor(() => expect(postMessage.mock.calls).toEqual([["glide"], ["snap"]]));
  document.querySelector("[data-wheel]")!.remove();
  await vi.waitFor(() => expect(postMessage.mock.calls).toEqual([["glide"], ["snap"], ["glide"]]));
  expect(document.elementFromPoint).toHaveBeenCalledWith(30, 40);
});

it("adds nothing in a plain browser", () => {
  const add = vi.spyOn(window, "addEventListener");
  watchWheelPlaces(window);
  expect(add).not.toHaveBeenCalled();
});
