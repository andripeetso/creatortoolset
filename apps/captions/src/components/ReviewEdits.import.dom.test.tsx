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

it("a reviewer sees the same timeline with its comment pins, without the edit tools", async () => {
  const view = importTimeline("Cut.edl", EDL, 25);
  const api = { timeline: vi.fn(async () => view), media: () => "media:play", stem: () => "" };
  const bridge = new ReviewSlotBridge();
  const pin = { selected: null, pins: { "V1:0": 2 }, onSelect: vi.fn(), onPin: vi.fn() };
  const ctx = {
    version: { n: 1, fps: 25, timeline: true, status: "ready" },
    api,
    player: { video: () => null, seek: () => {}, pause: () => {} },
    manage: false,
    sent: [],
    ...bridge.bind("tl"),
  } as unknown as ReviewSlotContext;
  await act(async () => root.render(<ReviewEdits {...ctx} pin={pin} />));
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

  expect(host.textContent).toContain("Click a clip to comment on it");
  expect(host.textContent).toContain("A.MP4");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Edit")).toBe(false);
  // the first clip carries its two comments' count
  expect([...host.querySelectorAll("*")].some((el) => el.children.length === 0 && el.textContent === "2")).toBe(true);
});

it("in the Mac app, an imported timeline's voice files are looked for where the timeline says, then in the folder picked", async () => {
  const take = (n: number) => `/Volumes/Tiny Drive/take ${n}.wav`;
  const view = importTimeline("Cut.edl", `TITLE: Cut
001  T1  A  C  00:00:00:00 00:00:02:00 01:00:00:00 01:00:02:00
* SOURCE FILE: ${take(1)}
002  T2  A  C  00:00:00:00 00:00:02:00 01:00:02:00 01:00:04:00
* SOURCE FILE: ${take(2)}
`, 25);
  const here = ["/Users/tiny/Moved/take 1.wav"];
  const path = (url: string) => new TextDecoder().decode(Uint8Array.from(atob(url.slice(16).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response("x", { status: here.includes(path(url)) ? 206 : 404 })));
  const post = vi.fn(async (b: { ask?: string }) => ({ granted: b.ask ? ["/Users/tiny/Moved"] : [] }));
  (window as unknown as { webkit: object }).webkit = { messageHandlers: { mediaAccess: { postMessage: post } } };
  document.documentElement.dataset.macLocalFiles = "3";
  try {
    const api = { timeline: vi.fn(async () => view), timelineSources: vi.fn(async () => ({ s1: take(1), s2: take(2) })), media: () => "", stem: () => "" };
    const bridge = new ReviewSlotBridge();
    const ctx = {
      asset: { id: "a1" },
      version: { n: 1, fps: 25, timeline: true, timelineFile: "Cut.edl", status: "ready" },
      api,
      player: { video: () => null, seek: () => {}, pause: () => {} },
      manage: true,
      sent: [],
      ...bridge.bind("tl"),
    } as unknown as ReviewSlotContext;
    const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
    await act(async () => root.render(<ReviewEdits {...ctx} />));
    await settle();
    expect(api.timelineSources).toHaveBeenCalledWith(1);
    const button = (t: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === t);
    await act(async () => button("Play edits from the originals")!.click());
    await settle();
    expect(post).toHaveBeenCalledWith({ ask: "/Volumes/Tiny Drive" });
    expect(host.textContent).toContain("1 of 2 files found");
    expect(button("Find the original files")).toBeDefined();
    expect(JSON.parse(localStorage.getItem("ct.review.relink.a1.1")!)).toEqual({ [take(1)]: here[0] });
  } finally {
    vi.unstubAllGlobals();
    delete (window as unknown as { webkit?: object }).webkit;
    delete document.documentElement.dataset.macLocalFiles;
  }
});
