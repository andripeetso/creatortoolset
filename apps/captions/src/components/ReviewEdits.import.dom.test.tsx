// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { importTimeline } from "@contracts/timeline-import";
import type { ReviewSlotContext } from "@/lib/plugin";
import { ReviewSlotBridge } from "@/lib/review-slots";
import ReviewEdits from "./ReviewEdits";

// An imported timeline file in core, with no plug-in: the real timeline editor draws the file's clips under the
// player (an EDL's view has no frame size and no media room), and its Edit mode is there with no Reframe.
vi.mock("@/lib/waveform", async (real) => ({ ...(await real<typeof import("@/lib/waveform")>()), peaks: vi.fn(async () => new Float32Array([0.5])) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EDL = `TITLE: Cut
FCM: NON-DROP FRAME

001  AX       V     C        09:07:38:22 09:07:40:22 01:00:00:00 01:00:02:00
* FROM CLIP NAME: A.MP4

002  AX       V     C        09:07:43:24 09:07:45:14 01:00:02:00 01:00:03:15
* FROM CLIP NAME: B.MP4
`;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("a version with an imported EDL draws the timeline editor with the file's clips", async () => {
  const view = importTimeline("Cut.edl", EDL, 25);
  const api = { timeline: vi.fn(async () => view), media: () => "media:play", stem: () => "" };
  const bridge = new ReviewSlotBridge();
  const ctx = {
    version: { n: 1, fps: 25, timeline: true, timelineFile: "Cut.edl", status: "ready" },
    api,
    player: { video: () => null, seek: () => {}, pause: () => {} },
    manage: true,
    sent: [],
    ...bridge.bind("tl"),
  } as unknown as ReviewSlotContext;
  await act(async () => root.render(<ReviewEdits {...ctx} />));
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

  expect(api.timeline).toHaveBeenCalledWith(1);
  expect(host.textContent).toContain("Timeline edits: sent with your next comment");
  expect(host.textContent).toContain("A.MP4");
  expect(host.textContent).toContain("B.MP4");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Edit")).toBe(true);
  expect(host.textContent).not.toContain("Reframe");
});
