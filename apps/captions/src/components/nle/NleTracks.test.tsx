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
      onLive={onLive} onCommit={onCommit} onBlade={() => {}} onMenu={() => {}} onTrack={() => {}}
      nameOf={(i) => i.src} zoomKeys={{ current: null }} fileOf={(src) => (src === "a" ? { url: "" } : null)} {...props} />,
  ));
  const pointer = (el: Element, type: string, clientX: number, altKey = false, more: PointerEventInit = {}) =>
    act(() => void el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, clientY: 10, button: 0, buttons: 1, altKey, ...more })));
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

  it("a flash whose file is missing is drawn as it is, never offline: the player draws it", async () => {
    const flash = withKeys({ ...tl, tracks: { V1: { items: [{ src: "gone", rec: 0, len: 10, in: 0, fx: "flash" }] }, A1: { items: [] } } } as unknown as NleTimeline);
    const { host, root } = await mount({ tl: flash });
    const clip = host.querySelector("[data-clip]") as HTMLElement;
    expect(clip.title).toBe("");
    expect(clip.className).not.toContain("bg-[#4a0909]");
    act(() => root.unmount());
  });
});

// a shot with its voice, linked, and a song
const linked = withKeys({
  timeline: { fps: 25 },
  sources: { a: { path: "/m/a.mp4" }, song: { path: "/m/song.wav" } },
  tracks: { V1: { items: [{ src: "a", rec: 0, len: 100, in: 0, link: 1 }] }, A1: { items: [{ src: "a", rec: 0, len: 100, in: 0, link: 1 }] }, A2: { items: [{ src: "song", rec: 0, len: 100, in: 0 }] } },
} as unknown as NleTimeline);
const [shot, voice, song] = [linked.tracks.V1.items[0]._k!, linked.tracks.A1.items[0]._k!, linked.tracks.A2.items[0]._k!];

describe("picking clips", () => {
  it("Linked Selection: a click picks the shot and its voice, ⌥-click the shot alone, off: the shot alone", async () => {
    const { host, root, onSelect, pointer } = await mount({ tl: linked });
    const clip = host.querySelector('[data-clip][aria-label^="V1"]')!;
    await pointer(clip, "pointerdown", 500);
    expect(onSelect).toHaveBeenLastCalledWith([shot, voice]);
    await pointer(clip, "pointerup", 500);
    await pointer(clip, "pointerdown", 500, true);
    expect(onSelect).toHaveBeenLastCalledWith([shot]);
    await pointer(clip, "pointerup", 500, true);
    act(() => root.unmount());
    const off = await mount({ tl: linked, linkedSelection: false });
    await off.pointer(off.host.querySelector('[data-clip][aria-label^="V1"]')!, "pointerdown", 500);
    expect(off.onSelect).toHaveBeenLastCalledWith([shot]);
    act(() => off.root.unmount());
  });

  it("a box drawn on empty space picks every clip it touches on every track; a plain click there lets go", async () => {
    const { host, root, onSelect, pointer } = await mount({ tl: linked, selected: [song] });
    const lane = host.querySelector('[data-lane="A2"]')!;
    await pointer(lane, "pointerdown", 153);
    expect(onSelect).toHaveBeenLastCalledWith([]);
    // every lane is 0–40 px tall here, so the box spans them all; it starts just after 0:00
    await pointer(lane, "pointermove", 160, false, { clientY: 30 });
    expect(onSelect).toHaveBeenLastCalledWith([shot, voice, song]);
    await pointer(lane, "pointerup", 160);
    expect((host.querySelector("[data-box]") as HTMLElement).style.display).toBe("none");
    act(() => root.unmount());
  });

  it("the track menu adds a video track above V1 and greys what can't be done", async () => {
    const onCommit = vi.fn();
    const { host, root } = await mount({ tl: linked, onCommit });
    const head = host.querySelector('[data-lane="V1"]')!.previousElementSibling!;
    await act(() => void head.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })));
    const item = (name: string) => [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === name) as HTMLButtonElement;
    expect(item("Delete Track").disabled).toBe(true); // the only video track
    expect(item("Move Track Up").disabled).toBe(true);
    expect(item("Delete Empty Tracks").disabled).toBe(true);
    await act(() => item("Video Track Above").click());
    expect(Object.keys((onCommit.mock.calls[0][0] as NleTimeline).tracks).sort()).toEqual(["A1", "A2", "V1", "V2"]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    act(() => root.unmount());
  });
});
