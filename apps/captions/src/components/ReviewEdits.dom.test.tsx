// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewPlayPlan, ReviewSlotContext, ReviewTimelineSlot } from "@/lib/plugin";
import { ReviewSlotBridge } from "@/lib/review-slots";
import { loudest, peaks } from "@/lib/waveform";
import type { TimelineView } from "@contracts/edit-timeline";
import ReviewEdits from "./ReviewEdits";

// the lane peaks are decoded from the sound in the browser: a stand-in here (happy-dom has no audio decoder)
vi.mock("@/lib/waveform", () => ({
  peaks: vi.fn(async () => new Float32Array([0.5])),
  loudest: vi.fn(() => new Float32Array([0.7])),
}));

// The Review panel in a DOM: its gate, the sent edits it shows on the timeline, the preview toggle and the plan it sends
// the player, and the bridge's ⌘Z and sent wiring. Typing chips and dragging a shot need the timeline's own pointer
// work, so those stay in edit-history.test.ts.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The timeline's pointer work is not driven here: a stand-in timeline has buttons that make the same calls it makes
// (an edit on the first shot, a placeholder, its removal). The chips, payload, ⌘Z and sent paths are the panel's own.
vi.mock("./EditTimeline", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  return {
    EditTimeline: (p: {
      view: { tracks: { items: unknown[] }[] };
      waves?: Record<string, Float32Array> | null;
      onEdit: (c: [unknown, object][]) => void;
      onPlaceholder: (h: object | null) => void;
      onColor?: (item: unknown) => void;
      onReframe?: (item: unknown) => void;
    }) => {
      const first = p.view.tracks[0].items[0];
      return createElement("div", null,
        createElement("p", { "data-testid": "lanes" }, `lanes:${Object.keys(p.waves ?? {}).sort().join(",")}`),
        p.onReframe && createElement("button", { onClick: () => p.onReframe!(first) }, "stub reframe"),
        createElement("button", { onClick: () => p.onEdit([[first, { remove: true }]]) }, "stub remove"),
        createElement("button", { onClick: () => p.onPlaceholder({ id: "h1", track: "V2", rec: 10, len: 20 }) }, "stub hole"),
        createElement("button", { onClick: () => p.onPlaceholder(null) }, "stub clear hole"),
        createElement("button", { onClick: () => p.onColor?.(first) }, "stub colour"));
    },
  };
});

// The colour panel's wheels are not driven here: a stand-in calls the two things the panel
// hands the review panel, its grade as it changes (onLive) and a gesture's grade applied (onApply), and its close
vi.mock("./GradePanel", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  const real = await vi.importActual<typeof import("./GradePanel")>("./GradePanel");
  const grade = { lift: [0, 0, 0], gamma: [0, 0, 0], gain: [1.1, 1, 1], offset: [0, 0, 0], contrast: 1.1, pivot: 0.435, sat: 0.9 };
  return {
    GradeFilter: real.GradeFilter,
    GradePanel: (p: { item: unknown; onLive: (g: object | null) => void; onApply: (c: [unknown, object][]) => void; onClose: () => void }) =>
      createElement("div", { "data-testid": "grade-panel" },
        createElement("button", { onClick: () => p.onLive(grade) }, "stub grade live"),
        createElement("button", { onClick: () => p.onApply([[p.item, { grade }]]) }, "stub grade apply"),
        createElement("button", { onClick: p.onClose }, "stub close colour")),
  };
});

const view: TimelineView = {
  name: "cut",
  fps: 25,
  duration: 8,
  width: 1080,
  height: 1920,
  tracks: [
    { id: "V1", name: "V1", items: [
      { key: "V1:0", track: "V1", rec: 0, len: 100, label: "Shot one" },
      { key: "V1:100", track: "V1", rec: 100, len: 100, label: "Shot two" },
    ] },
    { id: "A1", name: "A1", items: [{ key: "A1:0", track: "A1", rec: 0, len: 200, label: "Voice" }] },
  ],
  markers: [],
  words: [],
  flags: [],
};

const edit = { project: "p", draft: "d" };

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

/** Mounts the panel on a real bridge (the page's wiring) with a given `sent` list. */
async function mount(
  sent: { id: string; data: unknown }[],
  version: object = { n: 1, fps: 25, timeline: true, edit },
  api: object = { timeline: async () => view },
  hooks?: ReviewTimelineSlot,
) {
  const bridge = new ReviewSlotBridge();
  const bound = bridge.bind("tl");
  const ctx = {
    version,
    api,
    player: { video: () => null, seek: () => {}, pause: () => {} },
    manage: true,
    sent,
    ...bound,
    preview: { setPlan: vi.fn(bound.preview.setPlan) },
  } as unknown as ReviewSlotContext;
  await act(async () => root.render(<ReviewEdits {...ctx} hooks={hooks} />));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { bridge, ctx };
}

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);

describe("ReviewEdits panel", () => {
  it("shows nothing until the version has a timeline", async () => {
    await mount([], { n: 1, fps: 25, timeline: false });
    expect(host.innerHTML).toBe("");
  });

  it("an imported timeline (XML, OTIO, EDL) gets the panel too, with its sent edits playing", async () => {
    const removeFirst = { id: "c1", data: { edits: [{ key: "V1:0", label: "Shot one", remove: true }] } };
    const { bridge } = await mount([removeFirst], { n: 1, fps: 25, timeline: true });
    expect(host.textContent).toContain("Timeline edits: sent with your next comment");
    expect((bridge.plan() as ReviewPlayPlan).skips).toEqual([[0, 100]]);
  });

  it("a sent remove plays as a skip, and the toggle hides and shows it", async () => {
    const removeFirst = { id: "c1", data: { edits: [{ key: "V1:0", label: "Shot one", remove: true }] } };
    const { bridge, ctx } = await mount([removeFirst]);
    const setPlan = ctx.preview.setPlan as unknown as ReturnType<typeof vi.fn>;

    // the sent edit is still on the timeline, so the plan skips its span
    const shown = bridge.plan() as ReviewPlayPlan;
    expect(shown.skips).toEqual([[0, 100]]);
    expect(setPlan).toHaveBeenCalled();
    expect(host.textContent).toContain("Timeline edits: sent with your next comment");

    // the toggle is shown because the plan plays something; hiding it clears the player's plan
    await act(async () => button("Edits shown")!.click());
    expect(bridge.plan()).toBeNull();
    expect(button("Edits hidden")).toBeDefined();

    await act(async () => button("Edits hidden")!.click());
    expect((bridge.plan() as ReviewPlayPlan).skips).toEqual([[0, 100]]);
  });

  it("with nothing planned there is no toggle", async () => {
    const { bridge } = await mount([]);
    expect(button("Edits shown")).toBeUndefined();
    expect(button("Edits hidden")).toBeUndefined();
    expect(bridge.plan()).toBeNull();
  });

  it("a sent comment's edits stay on the timeline, and the chips and payload stay empty", async () => {
    const { bridge } = await mount([{ id: "c1", data: { edits: [{ key: "V1:100", label: "Shot two", remove: true }] } }]);
    expect(bridge.pendingLabels()).toEqual([]);
    expect(bridge.payload()).toBeUndefined();
    expect((bridge.plan() as ReviewPlayPlan).skips).toEqual([[100, 200]]);
  });

  it("⌘Z goes to the panel's history through the bridge, and a sent comment clears its state", async () => {
    const { bridge } = await mount([]);
    // the panel registered its history: the bridge hands ⌘Z to it (true = a plug-in took it)
    expect(bridge.history(false)).toBe(true);
    expect(bridge.history(true)).toBe(true);
    // a sent comment runs the panel's onSent (it resets its history and crop) without error
    expect(() => bridge.sent()).not.toThrow();
    expect(bridge.pendingLabels()).toEqual([]);
  });

  it("a user's remove goes into the comment box as a chip and the payload, and ⌘Z takes it back", async () => {
    const { bridge } = await mount([]);
    await act(async () => button("stub remove")!.click());
    expect(bridge.pendingLabels().length).toBeGreaterThan(0);
    const payload = bridge.payload() as { tl: { edits: { key: string; remove?: boolean }[] } };
    expect(payload.tl.edits).toEqual([expect.objectContaining({ key: "V1:0", remove: true })]);
    expect((bridge.plan() as ReviewPlayPlan).skips).toEqual([[0, 100]]);

    await act(async () => expect(bridge.history(false)).toBe(true));
    expect(bridge.pendingLabels()).toEqual([]);
    expect(bridge.payload()).toBeUndefined();
    expect(bridge.plan()).toBeNull();
  });

  it("a sent comment resets the panel's own edits: chips, payload, the plan and the undo", async () => {
    const { bridge } = await mount([]);
    await act(async () => button("stub remove")!.click());
    expect(bridge.plan()).not.toBeNull();
    await act(async () => bridge.sent());
    expect(bridge.pendingLabels()).toEqual([]);
    expect(bridge.payload()).toBeUndefined();
    expect(bridge.plan()).toBeNull();
    // the edit is gone from the history too: ⌘Z has nothing of this panel's to undo
    await act(async () => expect(bridge.history(false)).toBe(true));
    expect(bridge.payload()).toBeUndefined();
  });

  it("a placeholder shows the comment's typed words on the picture, or 'Placeholder' while none are typed", async () => {
    const { bridge } = await mount([]);
    await act(async () => button("stub hole")!.click());
    const label = () => (bridge.plan() as ReviewPlayPlan).cards.find((c) => c.kind === "hole")?.label;
    expect(label()).toBe("Placeholder");
    await act(async () => bridge.setComposerText("  Lower third: the name  "));
    expect(label()).toBe("Lower third: the name");
    expect(bridge.textNeeded()).toBe("Say what goes in the placeholder");
  });

  it("a sent grade plays as a look over its shot, and its SVG filter is drawn in the panel", async () => {
    const grade = { lift: [0, 0, 0], gamma: [0, 0, 0], gain: [1.1, 1, 1], offset: [0, 0, 0], contrast: 1.1, pivot: 0.435, sat: 0.9 };
    const { bridge } = await mount([{ id: "c1", data: { edits: [{ key: "V1:0", label: "Shot one", grade }] } }]);
    const shown = bridge.plan() as ReviewPlayPlan;
    expect(shown.looks).toEqual([{ from: 0, to: 100, filter: "url(#review-grade-0)" }]);
    expect(host.querySelector('filter[id="review-grade-0"]')).not.toBeNull();
    expect(host.textContent).toContain("Timeline edits: sent with your next comment");
  });

  it("Color opens the grade panel, and the shot plays the panel's grade live until the panel closes", async () => {
    const { bridge } = await mount([]);
    expect(host.querySelector('[data-testid="grade-panel"]')).toBeNull();
    await act(async () => button("stub colour")!.click());
    expect(host.querySelector('[data-testid="grade-panel"]')).not.toBeNull();
    expect(bridge.plan()).toBeNull();

    await act(async () => button("stub grade live")!.click());
    expect((bridge.plan() as ReviewPlayPlan).looks).toEqual([{ from: 0, to: 100, filter: "url(#review-grade-live)" }]);
    expect(host.querySelector('filter[id="review-grade-live"]')).not.toBeNull();

    await act(async () => button("stub close colour")!.click());
    expect(host.querySelector('[data-testid="grade-panel"]')).toBeNull();
    expect(bridge.plan()).toBeNull();
    expect(host.querySelector('filter[id="review-grade-live"]')).toBeNull();
  });

  it("a grade applied in the panel goes into the comment box, and the live look then covers the shot instead of its planned grade", async () => {
    const { bridge } = await mount([]);
    await act(async () => button("stub colour")!.click());
    await act(async () => button("stub grade apply")!.click());
    expect(bridge.pendingLabels().length).toBeGreaterThan(0);
    expect((bridge.payload() as { tl: { edits: { key: string; grade?: object }[] } }).tl.edits)
      .toEqual([expect.objectContaining({ key: "V1:0", grade: expect.any(Object) })]);
    // the applied grade is planned on the shot, but the panel's live grade (the same shot) plays in its place
    await act(async () => button("stub grade live")!.click());
    expect((bridge.plan() as ReviewPlayPlan).looks).toEqual([{ from: 0, to: 100, filter: "url(#review-grade-live)" }]);
  });

  it("a version with stems draws its voice on A1 and the rest on the other lanes", async () => {
    const stems = { groups: [{ key: "abc", label: "Voice", mix: 1 }], fx: ["enhanced"], voice: "enhanced" };
    const api = { timeline: async () => view, stem: vi.fn((_v: unknown, f: string) => `stem:${f}`), media: vi.fn(() => "media:play") };
    await mount([], { n: 1, fps: 25, timeline: true, edit, status: "ready", stems }, api);
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(api.stem).toHaveBeenCalledWith(expect.anything(), "abc.original.m4a");
    expect(api.stem).toHaveBeenCalledWith(expect.anything(), "rest.m4a");
    expect(api.media).not.toHaveBeenCalled();
    expect(loudest).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="lanes"]')?.textContent).toBe("lanes:*,A1");
  });

  it("a version without stems keeps the placeholder: its sound on every audio lane", async () => {
    const api = { timeline: async () => view, stem: vi.fn(), media: vi.fn((_v: unknown, f: string) => `media:${f}`) };
    vi.mocked(peaks).mockClear();
    await mount([], { n: 1, fps: 25, timeline: true, edit, status: "ready" }, api);
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
    expect(api.media).toHaveBeenCalledWith(expect.anything(), "play");
    expect(api.stem).not.toHaveBeenCalled();
    expect(peaks).toHaveBeenCalledWith("media:play");
    expect(host.querySelector('[data-testid="lanes"]')?.textContent).toBe("lanes:*");
  });

  it("Reframe needs the AI edit and a plug-in's camera frame; the camera frame shows under the window", async () => {
    await mount([]);
    expect(button("stub reframe")).toBeUndefined();
    await act(async () => root.unmount());
    root = createRoot(host);
    const camera = vi.fn(async () => "cam.mp4");
    await mount([], { n: 1, fps: 25, timeline: true }, undefined, { camera });
    expect(button("stub reframe")).toBeUndefined();
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount([], undefined, undefined, { camera });
    await act(async () => button("stub reframe")!.click());
    expect(camera).toHaveBeenCalledWith(edit, expect.any(AbortSignal));
    expect(host.querySelector('video[src="cam.mp4"]')).not.toBeNull();
  });

  it("a plug-in's clip plays in a moved overlay's card", async () => {
    const withClip: TimelineView = { ...view, tracks: [...view.tracks, { id: "V2", name: "V2", items: [{ key: "V2:20", track: "V2", rec: 20, len: 30, label: "roll", clip: 7, ins: 1 }] }] };
    const { bridge } = await mount([{ id: "c1", data: { edits: [{ key: "V2:20", label: "roll", move: 10 }] } }],
      undefined, { timeline: async () => withClip }, { clipSrc: (c) => `/clips/${c}` });
    const added = (bridge.plan() as ReviewPlayPlan).cards.find((c) => c.kind === "added");
    expect(added).toMatchObject({ src: "/clips/7" });
  });

  it("in the Mac app, a stretched voice plays its words from the original recording once its folder is allowed", async () => {
    const voiced: TimelineView = { ...view, tracks: [
      view.tracks[0],
      { id: "A1", name: "A1", items: [{ key: "A1:0", track: "A1", rec: 0, len: 200, label: "Voice", src: "vo", ins: 2 }] },
    ] };
    let granted: string[] = [];
    const post = vi.fn(async (b: { ask?: string; list?: boolean }) => {
      if (b.ask) granted = [b.ask];
      return { granted };
    });
    (window as unknown as { webkit: object }).webkit = { messageHandlers: { mediaAccess: { postMessage: post } } };
    document.documentElement.dataset.macLocalFiles = "3";
    try {
      const sources = vi.fn(async () => ({ vo: "/Volumes/Shoot/VO/take 1.wav" }));
      const longer = { id: "c1", data: { edits: [{ key: "A1:0", label: "Voice", tail: 25 }, { key: "V1:100", label: "Shot two", tail: 25 }] } };
      const { bridge } = await mount([longer], undefined, { timeline: async () => voiced }, { sources });
      expect(sources).toHaveBeenCalledWith(edit, expect.any(AbortSignal));
      // not allowed yet: the cut plays as before, and the timeline offers the originals
      expect((bridge.plan() as ReviewPlayPlan).sound).toBeUndefined();
      await act(async () => button("Play edits from the originals")!.click());
      expect(post).toHaveBeenCalledWith({ ask: "/Volumes/Shoot/VO" });
      // allowed: the voice plays from its recording, 25 frames longer, into the hold the longer shot makes
      expect((bridge.plan() as ReviewPlayPlan).sound).toEqual([
        { src: `ctlocal://media/${btoa("/Volumes/Shoot/VO/take 1.wav").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}`, at: 0, frames: 225, offset: 2 },
      ]);
      expect(button("Play edits from the originals")).toBeUndefined();
    } finally {
      delete (window as unknown as { webkit?: object }).webkit;
      delete document.documentElement.dataset.macLocalFiles;
    }
  });

  it("unmounting clears the plan the player follows", async () => {
    const { bridge } = await mount([{ id: "c1", data: { edits: [{ key: "V1:0", label: "Shot one", remove: true }] } }]);
    expect(bridge.plan()).not.toBeNull();
    await act(async () => root.unmount());
    expect(bridge.plan()).toBeNull();
    root = createRoot(host);
  });
});

describe("Face (the face refinement strength)", () => {
  it("a ?face= link opens it paused on that frame, fades over the video and keeps a new strength", async () => {
    const stage = document.createElement("div");
    const video = document.createElement("video");
    stage.append(video);
    document.body.append(stage);
    const seek = vi.fn((t: number) => {
      video.currentTime = t;
      video.dispatchEvent(new Event("seeked"));
    });
    const face = { max: 2, still: vi.fn(async () => "blob:face"), strength: vi.fn(async () => 1.2), save: vi.fn(async () => {}) };
    const bound = new ReviewSlotBridge().bind("tl");
    const ctx = {
      version: { n: 1, fps: 25, timeline: true, edit }, api: { timeline: async () => view },
      player: { video: () => video, seek, pause: () => {} }, manage: true, sent: [], ...bound,
    } as unknown as ReviewSlotContext;
    await act(async () => root.render(<ReviewEdits {...ctx} hooks={{ face }} faceAt={150} />));
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });

    expect(seek).toHaveBeenCalledWith(6);
    expect(host.textContent).toContain("Face refinement");
    expect(face.still).toHaveBeenCalledWith(edit, "V1:100", 150, expect.anything());
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.value).toBe("120");
    expect(stage.querySelectorAll("div[style*='blob:face']")).toHaveLength(2);   // as filmed, and the full strength over it

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "80");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Use 80% for this edit")!.click());
    expect(face.save).toHaveBeenCalledWith(edit, 0.8);
    expect(host.textContent).toContain("A new version with this strength is on its way");
    stage.remove();
  });
});
