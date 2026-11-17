// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowCrop } from "@contracts/editor";
import type { TimelineItem } from "@contracts/edit-timeline";
import { WindowBox } from "./RecropBox";

// a 9:16 frame over a 16:9 picture: the window is a third of its width, following who talks (held at 0.2), and the
// paths it can take
const shot = (crop?: WindowCrop) => ({
  key: "V1:0", track: "V1", rec: 0, len: 50, label: "Hello", src: "v1", ins: 10,
  window: { path: [{ t: 0, x: 0.2 }], from: 10, w: 1 / 3, follow: { 0: [{ t: 0, x: 0.2 }], 1: [{ t: 0, x: 0.1 }], 2: [{ t: 0, x: 0.9 }] }, ...(crop ? { crop } : {}) },
}) as TimelineItem & { window: NonNullable<TimelineItem["window"]> };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const draw = (item: ReturnType<typeof shot>, crop: WindowCrop | undefined, onCrop: (c: WindowCrop | undefined) => void) =>
  act(() => root.render(<WindowBox item={item} aspect={9 / 16} src="/x.mp4" mediaAt={10.5} crop={crop} onCrop={onCrop} onClose={() => {}} />));
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name)!;
const frameLeft = () => parseFloat((host.querySelector(".outline-white") as HTMLElement).style.left);

describe("Reframe on a reframed moment", () => {
  it("shows the frame where the shot has it and offers each speaker; a pick is an edit, the shot's own choice clears it", () => {
    const onCrop = vi.fn();
    draw(shot(), undefined, onCrop);
    expect(frameLeft()).toBeCloseTo(0.2 * (2 / 3) * 100, 6);
    expect(button("Who talks").className).toContain("bg-violet-600");
    act(() => button("Speaker 2").click());
    expect(onCrop).toHaveBeenLastCalledWith({ speaker: 2 });
    // pending Speaker 2: the frame shows where that path has it
    draw(shot(), { speaker: 2 }, onCrop);
    expect(frameLeft()).toBeCloseTo(0.9 * (2 / 3) * 100, 6);
    act(() => button("Who talks").click());
    expect(onCrop).toHaveBeenLastCalledWith(undefined);
  });

  it("on a shot a hand already set, going back to who talks is an edit of its own, and arrows nudge the frame", () => {
    const onCrop = vi.fn();
    draw(shot({ x: 0.5 }), undefined, onCrop);
    expect(button("Held")).toBeUndefined(); // a state, not a button
    expect(host.textContent).toContain("Held");
    act(() => button("Who talks").click());
    expect(onCrop).toHaveBeenLastCalledWith({ speaker: 0 });
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true })));
    expect(onCrop).toHaveBeenLastCalledWith({ x: 0.6 });
  });
});
