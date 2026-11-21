// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { find, withKeys, type NleTimeline } from "@/lib/nle/model";
import { DurationDialog } from "./NleDurationDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// a 2 s shot at 200 % of a 4 s file (it uses 100 of its 100 frames), with its voice at 100 %
const tl = withKeys({
  timeline: { fps: 25, name: "Rolls" },
  sources: { a: { path: "/m/a.mp4", fps: 25, dur: 100 } },
  tracks: { V1: { items: [{ src: "a", rec: 0, len: 50, in: 0, speed: 2, link: 1 }] }, A1: { items: [{ src: "a", rec: 0, len: 50, in: 0, link: 1 }] } },
} as unknown as NleTimeline);
const [v, a] = [tl.tracks.V1.items[0]._k!, tl.tracks.A1.items[0]._k!];

it("takes frames or a timecode, refuses a length past the source counting speed, and trims the picked clips' ends", async () => {
  const onCommit = vi.fn();
  const onClose = vi.fn();
  const host = document.body.appendChild(document.createElement("div"));
  await act(async () => createRoot(host).render(<DurationDialog tl={tl} keys={[v, a]} onCommit={onCommit} onClose={onClose} />));
  const input = document.querySelector<HTMLInputElement>("#nle-duration")!;
  const change = [...document.querySelectorAll("button")].find((b) => b.textContent === "Change")!;
  const type = (x: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, x);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(input.value).toBe("0:02:00");
  // 51 frames at 200 % need 102 source frames of 100
  await type("51");
  expect(change.disabled).toBe(true);
  expect(document.body.textContent).toContain("Longer than the source: 0:02:00 at most");
  await type("two");
  expect(change.disabled).toBe(true);
  await type("1:05");
  expect(change.disabled).toBe(false);
  await act(async () => void change.click());
  const next = onCommit.mock.calls[0][0] as NleTimeline;
  expect([find(next, v)?.item.len, find(next, a)?.item.len]).toEqual([30, 30]);
  expect(onClose).toHaveBeenCalled();
});
