// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { withKeys, type NleTimeline } from "@/lib/nle/model";
import { NleTracks } from "./NleTracks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// a Tiny Acrobatics cut: one shot here, one whose file isn't, one whose file isn't
const tl: NleTimeline = withKeys({
  timeline: { fps: 25 },
  sources: { a: { path: "/m/a.mp4" }, gone: { path: "/m/gone.mp4" } },
  tracks: { V1: { items: [{ src: "a", rec: 0, len: 100, in: 0 }, { src: "gone", rec: 200, len: 50, in: 0 }] }, A1: { items: [] } },
} as unknown as NleTimeline);

// every box 1000 px wide from 0 (happy-dom lays nothing out): a clip's ends are at its edges, its middle is the body
vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, right: 1000, width: 1000, top: 0, bottom: 40, height: 40, x: 0, y: 0, toJSON: () => ({}) });
vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);

const mount = async (props: Partial<Parameters<typeof NleTracks>[0]> = {}) => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const onLive = vi.fn();
  const onCommit = vi.fn();
  const onSelect = vi.fn();
  await act(async () => root.render(
    <NleTracks tl={tl} time={0} selected={[]} tool="select" snap={false} marks={[null, null]} onSeek={() => {}} onSelect={onSelect}
      onLive={onLive} onCommit={onCommit} onBlade={() => {}} onMenu={() => {}} onTrack={() => {}} onRemoveTrack={() => {}}
      nameOf={(i) => i.src} zoomKeys={{ current: null }} fileOf={(src) => (src === "a" ? { url: "" } : null)} {...props} />,
  ));
  const pointer = (el: Element, type: string, clientX: number, altKey = false) =>
    act(() => void el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, button: 0, buttons: 1, altKey })));
  return { host, root, onLive, onCommit, onSelect, pointer };
};

describe("the timeline's clips", () => {
  it("draws a clip whose file isn't here as offline, saying why", async () => {
    const { host, root } = await mount();
    const clips = [...host.querySelectorAll("[data-clip]")] as HTMLElement[];
    expect(clips.map((c) => c.title)).toEqual(["", "Media offline"]);
    act(() => root.unmount());
  });

  it("a drag on a clip's top corner sets its fade, one step when let go", async () => {
    const { host, root, onLive, onCommit, pointer } = await mount();
    const handle = host.querySelector('[aria-label="Fade in"]')!;
    await pointer(handle, "pointerdown", 0);
    await pointer(handle, "pointermove", 400);
    expect(onLive).toHaveBeenCalled();
    await pointer(handle, "pointerup", 400);
    const done = onCommit.mock.calls[0][0] as NleTimeline;
    expect(done.tracks.V1.items[0].fade_in).toBeGreaterThan(0);
    expect(done.tracks.V1.items[0].fade_in).toBeLessThanOrEqual(100);
    act(() => root.unmount());
  });

  it("⌥-drag leaves the clip and moves a copy, which is picked", async () => {
    const { host, root, onCommit, onSelect, pointer } = await mount();
    const clip = host.querySelector("[data-clip]")!;
    await pointer(clip, "pointerdown", 500, true);
    await pointer(clip, "pointermove", 4500, true);
    await pointer(clip, "pointerup", 4500, true);
    const done = onCommit.mock.calls[0][0] as NleTimeline;
    const shots = done.tracks.V1.items.filter((i) => i.src === "a");
    expect(shots).toHaveLength(2);
    expect(shots[0].rec).toBe(0);
    expect(onSelect).toHaveBeenLastCalledWith([shots[1]._k]);
    act(() => root.unmount());
  });
});
