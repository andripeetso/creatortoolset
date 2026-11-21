// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useWorkPrefs } from "@/lib/setup";
import type { TimelineView } from "@contracts/edit-timeline";
import { EditTimeline, OWN_CUT_RULES } from "./EditTimeline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// two shots and their voice; the playhead in the first one (2 s = frame 50 of 0–100)
const view = {
  name: "cut", fps: 25, duration: 8, width: 1080, height: 1920, markers: [], words: [], flags: [],
  tracks: [
    { id: "V1", name: "V1", items: [
      { key: "V1:0", track: "V1", rec: 0, len: 100, label: "Shot one" },
      { key: "V1:100", track: "V1", rec: 100, len: 100, label: "Shot two" },
    ] },
    { id: "A1", name: "A1", items: [{ key: "A1:0", track: "A1", rec: 0, len: 200, label: "Voice" }] },
  ],
} as unknown as TimelineView;

const press = (key: string) => {
  const e = new KeyboardEvent("keydown", { key, code: /^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, bubbles: true, cancelable: true });
  act(() => void document.body.dispatchEvent(e));
  return e;
};

it("takes the editor's keys: W and C cut at the playhead, Q / E trim the shot under it, and leaves 2 (play) and C outside Edit mode to the page", async () => {
  useWorkPrefs.setState({ prefs: {} as never }); // the default keys, nothing loaded
  const onEdit = vi.fn();
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<EditTimeline view={view} time={2} onSeek={() => {}} onEdit={onEdit} nle />));

  for (const k of ["w", "c"]) {
    onEdit.mockClear();
    expect(press(k).defaultPrevented).toBe(true);
    expect(onEdit.mock.calls[0][0]).toEqual([[expect.objectContaining({ key: "V1:0" }), { split: [expect.any(Number)] }]]);
  }
  onEdit.mockClear();
  press("q");
  expect(onEdit.mock.calls[0][0][0][1]).toHaveProperty("head");
  onEdit.mockClear();
  press("e");
  expect(onEdit.mock.calls[0][0][0][1]).toHaveProperty("tail");

  onEdit.mockClear();
  expect(press("2").defaultPrevented).toBe(false);
  expect(onEdit).not.toHaveBeenCalled();

  // a key a menu, dialog or overlay already took stays theirs, and ⌘= stays the browser's page zoom
  const taken = new KeyboardEvent("keydown", { key: "w", code: "KeyW", bubbles: true, cancelable: true });
  taken.preventDefault();
  act(() => void document.body.dispatchEvent(taken));
  expect(onEdit).not.toHaveBeenCalled();
  const pageZoom = new KeyboardEvent("keydown", { key: "=", code: "Equal", metaKey: true, bubbles: true, cancelable: true });
  act(() => void document.body.dispatchEvent(pageZoom));
  expect(pageZoom.defaultPrevented).toBe(false);

  // Review's timeline outside Edit mode: C is the page's (a comment)
  await act(async () => root.render(<EditTimeline view={view} time={2} onSeek={() => {}} onEdit={onEdit} />));
  expect(press("c").defaultPrevented).toBe(false);
  await act(async () => root.unmount());
});

it("R opens Change Clip Speed for the talent shot under the playhead: the shot and its voice at that rate; not where the cut can't take one", async () => {
  useWorkPrefs.setState({ prefs: {} as never });
  const onEdit = vi.fn();
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<EditTimeline view={view} time={2} onSeek={() => {}} onEdit={onEdit} nle />));
  expect(press("r").defaultPrevented).toBe(true);
  const input = document.querySelector<HTMLInputElement>("#nle-speed")!;
  expect(input.value).toBe("100");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "150");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Change")!.click());
  expect(onEdit).toHaveBeenLastCalledWith([[expect.objectContaining({ key: "V1:0" }), { speed: 1.5 }]]);
  expect(document.querySelector("#nle-speed")).toBeNull();

  // the app's own AI Editor cuts: its render plays no speed, so R does nothing there
  await act(async () => root.render(<EditTimeline view={view} time={2} onSeek={() => {}} onEdit={onEdit} rules={OWN_CUT_RULES} nle />));
  expect(press("r").defaultPrevented).toBe(false);
  expect(document.querySelector("#nle-speed")).toBeNull();
  await act(async () => root.unmount());
});
