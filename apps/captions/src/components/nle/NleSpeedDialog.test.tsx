// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { find, withKeys, type NleTimeline } from "@/lib/nle/model";
import { SpeedDialog } from "./NleSpeedDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// one 4 s shot of a 20 s file
const tl = withKeys({
  timeline: { fps: 25, name: "Rolls" },
  sources: { a: { path: "/m/a.mp4", fps: 25, dur: 500 } },
  tracks: { V1: { items: [{ src: "a", rec: 0, len: 100, in: 0 }] } },
} as unknown as NleTimeline);
const k = tl.tracks.V1.items[0]._k!;

async function open() {
  const onCommit = vi.fn();
  const onClose = vi.fn();
  const host = document.body.appendChild(document.createElement("div"));
  await act(async () => createRoot(host).render(<SpeedDialog tl={tl} keys={[k]} onCommit={onCommit} onClose={onClose} />));
  const input = document.querySelector<HTMLInputElement>("#nle-speed")!;
  const change = [...document.querySelectorAll("button")].find((b) => b.textContent === "Change")!;
  const type = (v: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return { onCommit, onClose, input, change, type };
}

it("sets the picked clips' speed in % and closes; out of 10–1600 it changes nothing", async () => {
  const d = await open();
  expect(d.input.value).toBe("100");
  await d.type("5");
  expect(d.change.disabled).toBe(true);
  await d.type("200");
  await act(async () => void d.change.click());
  expect(find(d.onCommit.mock.calls[0][0], k)?.item.speed).toBe(2);
  expect(d.onClose).toHaveBeenCalled();
});
