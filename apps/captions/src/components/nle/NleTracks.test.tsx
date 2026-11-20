// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { withKeys, type NleTimeline } from "@/lib/nle/model";
import { NleClock } from "@/lib/nle/audio";
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
    <NleTracks tl={tl} time={0} clock={new NleClock()} selected={[]} tool="select" snap={false} marks={[null, null]} onSeek={() => {}} onSelect={onSelect}
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

  it("a plain click on empty space asks for the gap there (gapAt), a box doesn't", async () => {
    const onGap = vi.fn();
    const { host, root, pointer } = await mount({ onGap });
    const lane = host.querySelector('[data-lane="V1"]')!;
    await pointer(lane, "pointerdown", 900);
    await pointer(lane, "pointerup", 900);
    expect(onGap).toHaveBeenCalledTimes(1);
    await pointer(lane, "pointerdown", 900);
    await pointer(lane, "pointermove", 960, false, { clientY: 30 });
    await pointer(lane, "pointerup", 960);
    expect(onGap).toHaveBeenLastCalledWith(null);
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

// two Tiny Acrobatics shots cut together with a centred 5-frame dissolve: the first has 10 frames of its source left after
// it, the second 3 before it, so the dissolve can grow to 7
const cut = withKeys({
  timeline: { fps: 25 },
  sources: { a: { path: "/m/a.mp4", fps: 25, dur: 160 } },
  tracks: { V1: { items: [{ src: "a", rec: 0, len: 50, in: 100 }, { src: "a", rec: 50, len: 50, in: 3, trans: { type: "dissolve", len: 5, at: "center" } }] }, A1: { items: [] } },
} as unknown as NleTimeline);
// px a second, from how wide a clip of `len` frames is drawn
const ppsOf = (el: Element, len: number) => parseFloat((el as HTMLElement).style.width) / (len / 25);

describe("transitions, markers, gaps and the new tools on the timeline", () => {
  it("a transition's band: a double click picks it, its end drags its length as far as the handles go, red where they stop it", async () => {
    const onTrans = vi.fn();
    const { host, root, onLive, onCommit, pointer } = await mount({ tl: cut, onTrans });
    const band = host.querySelector("[data-trans]")!;
    expect(band.getAttribute("aria-label")).toBe("Cross Dissolve V1");
    const pps = ppsOf(band, 5);
    const end = band.querySelector('[data-edge="tail"]')!;
    await pointer(end, "pointerdown", 500);
    expect(onTrans).not.toHaveBeenCalled();
    await pointer(end, "pointermove", 500 + pps); // a second on: wants 5 + 2 × 25 frames
    const live = onLive.mock.calls.at(-1)![0] as NleTimeline;
    expect(live.tracks.V1.items[1].trans!.len).toBe(7);
    expect(host.querySelector("[data-clamped]")).not.toBeNull();
    await pointer(end, "pointerup", 500 + pps);
    expect((onCommit.mock.calls[0][0] as NleTimeline).tracks.V1.items[1].trans!.len).toBe(7);
    expect(host.querySelector("[data-clamped]")).toBeNull();
    await act(() => void band.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(onTrans).toHaveBeenCalledWith(cut.tracks.V1.items[1]._k);
    act(() => root.unmount());
  });

  it("a right-click at a cut offers that cut; on a gap, the gap menu with the gap picked; on the ruler, the ruler menu", async () => {
    const onMenu = vi.fn();
    const onGap = vi.fn();
    const { host, root } = await mount({ tl: cut, onMenu, onGap });
    const ctx = (el: Element, clientX: number) => act(() => void el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY: 10 })));
    const later = host.querySelectorAll('[data-clip][aria-label^="V1"]')[1]!;
    await ctx(later, 3);
    expect(onMenu).toHaveBeenLastCalledWith(expect.objectContaining({ on: "clip", cut: cut.tracks.V1.items[1]._k }), cut.tracks.V1.items[1]._k);
    await ctx(later, 500);
    expect(onMenu.mock.calls.at(-1)![0].cut).toBeNull();
    act(() => root.unmount());

    const g = await mount({ onMenu, onGap });
    const pps = ppsOf(g.host.querySelector("[data-clip]")!, 100);
    await ctx(g.host.querySelector('[data-lane="V1"]')!, 152 + 6 * pps); // 6 s: between the shots
    expect(onGap).toHaveBeenLastCalledWith({ track: "V1", from: 100, to: 200 });
    expect(onMenu).toHaveBeenLastCalledWith(expect.objectContaining({ on: "gap" }), "");
    const ruler = g.host.querySelector('[title="The playhead"]')!.parentElement!.nextElementSibling!;
    await ctx(ruler, 300);
    expect(onMenu).toHaveBeenLastCalledWith(expect.objectContaining({ on: "ruler" }), "");
    act(() => g.root.unmount());
  });

  it("a marker on the ruler: a click puts the playhead on it, a drag moves it, a double click opens it", async () => {
    const onSeek = vi.fn();
    const onMarker = vi.fn();
    const marked = { ...tl, markers: [{ frame: 50, name: "Hook", color: "Red" }] } as NleTimeline;
    const { host, root, onCommit, pointer } = await mount({ tl: marked, onSeek, onMarker });
    const pps = ppsOf(host.querySelector("[data-clip]")!, 100);
    const m = host.querySelector('[data-marker="50"]')!;
    await pointer(m, "pointerdown", 400);
    await pointer(m, "pointerup", 400);
    expect(onSeek).toHaveBeenLastCalledWith(2);
    await pointer(m, "pointerdown", 400);
    await pointer(m, "pointermove", 400 + pps);
    await pointer(m, "pointerup", 400 + pps);
    expect((onCommit.mock.calls[0][0] as NleTimeline).markers).toEqual([{ frame: 75, name: "Hook", color: "Red" }]);
    expect(onSeek).toHaveBeenCalledTimes(1);
    await act(() => void m.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(onMarker).toHaveBeenCalledWith(50);
    act(() => root.unmount());
  });

  it("Slide moves a clip between its neighbours, they trim; Rate Stretch pulls an end and changes its speed", async () => {
    const three = withKeys({
      timeline: { fps: 25 },
      sources: { a: { path: "/m/a.mp4", fps: 25, dur: 1000 } },
      tracks: { V1: { items: [0, 50, 100].map((rec) => ({ src: "a", rec, len: 50, in: 200 })) }, A1: { items: [] } },
    } as unknown as NleTimeline);
    const s = await mount({ tl: three, tool: "slide" });
    const pps = ppsOf(s.host.querySelector("[data-clip]")!, 50);
    const mid = s.host.querySelectorAll("[data-clip]")[1]!;
    await s.pointer(mid, "pointerdown", 500);
    await s.pointer(mid, "pointermove", 500 + 0.4 * pps);
    await s.pointer(mid, "pointerup", 500 + 0.4 * pps);
    expect((s.onCommit.mock.calls[0][0] as NleTimeline).tracks.V1.items.map((i) => [i.rec, i.len])).toEqual([[0, 60], [60, 50], [110, 40]]);
    act(() => s.root.unmount());

    const r = await mount({ tl: three, tool: "stretch" });
    const last = r.host.querySelectorAll("[data-clip]")[2]!;
    await r.pointer(last, "pointerdown", 998);
    await r.pointer(last, "pointermove", 998 + 2 * pps);
    await r.pointer(last, "pointerup", 998 + 2 * pps);
    const it = (r.onCommit.mock.calls[0][0] as NleTimeline).tracks.V1.items[2];
    expect([it.len, it.speed]).toEqual([100, 0.5]);
    act(() => r.root.unmount());
  });
});

describe("keyframes and the volume line on the timeline", () => {
  // a Tiny Acrobatics cut: the shot plays at double speed with two zoom keys, the next shot has one, the voice has its gain
  const keyed = withKeys({
    timeline: { fps: 25 },
    sources: { a: { path: "/m/a.mp4" }, b: { path: "/m/b.mp4" }, v: { path: "/m/voice.wav" } },
    tracks: {
      V1: { items: [
        { src: "a", rec: 0, len: 100, in: 0, speed: 2, keys: { zoom: [[20, 1, "linear"], [120, 1.5, "ease"]] } },
        { src: "b", rec: 100, len: 50, in: 0, keys: { zoom: [[10, 2, "linear"]] } },
      ] },
      A1: { items: [{ src: "v", rec: 0, len: 100, in: 0 }] },
    },
  } as unknown as NleTimeline);
  const [shot, next] = keyed.tracks.V1.items.map((i) => i._k!);

  it("the picked clip alone shows a ◆ at each key's timeline frame; a click puts the playhead there", async () => {
    const onSeek = vi.fn();
    const { host, root, pointer } = await mount({ tl: keyed, selected: [shot], onSeek });
    const pps = ppsOf(host.querySelector("[data-clip]")!, 100);
    const marks = [...host.querySelectorAll("[data-keyframe]")] as HTMLElement[];
    // source frames 20 and 120 at double speed: timeline frames 10 and 60
    expect(marks.map((m) => Number(m.dataset.keyframe))).toEqual([10, 60]);
    expect(parseFloat(marks[1].style.left)).toBeCloseTo((60 / 25) * pps - 5);
    await pointer(marks[1], "pointerdown", 300);
    await pointer(marks[1], "pointerup", 300);
    expect(onSeek).toHaveBeenCalledWith(60 / 25);
    act(() => root.unmount());
  });

  it("a ◆ dragged a second on moves its key 25 timeline frames, 50 source frames at double speed, in one step", async () => {
    const { host, root, onLive, onCommit, pointer } = await mount({ tl: keyed, selected: [shot, next] });
    const pps = ppsOf(host.querySelector("[data-clip]")!, 100);
    expect(host.querySelectorAll("[data-keyframe]")).toHaveLength(3);
    const m = host.querySelector('[data-keyframe="10"]')!;
    await pointer(m, "pointerdown", 300);
    await pointer(m, "pointermove", 300 + pps / 2);
    await pointer(m, "pointermove", 300 + pps);
    expect(onLive).toHaveBeenCalled();
    await pointer(m, "pointerup", 300 + pps);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect((onCommit.mock.calls[0][0] as NleTimeline).tracks.V1.items[0].keys!.zoom).toEqual([[70, 1, "linear"], [120, 1.5, "ease"]]);
    act(() => root.unmount());
  });

  it("a right-click on a ◆ sets its ease or deletes it, through the Inspector's commands", async () => {
    const { host, root, onCommit } = await mount({ tl: keyed, selected: [shot] });
    const open = () => act(() => void host.querySelector('[data-keyframe="60"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 10 })));
    const item = (name: string) => [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].find((b) => b.textContent === name) as HTMLElement;
    await open();
    await act(() => item("Hold").click());
    expect(onCommit.mock.calls[0]).toEqual([expect.anything(), "Keyframe"]);
    expect((onCommit.mock.calls[0][0] as NleTimeline).tracks.V1.items[0].keys!.zoom).toEqual([[20, 1, "linear"], [120, 1.5, "hold"]]);
    await open();
    await act(() => item("Delete").click());
    expect((onCommit.mock.calls[1][0] as NleTimeline).tracks.V1.items[0].keys!.zoom).toEqual([[20, 1, "linear"]]);
    act(() => root.unmount());
  });

  it("the volume line drags the gain, showing the dB, one step when let go", async () => {
    const { host, root, onLive, onCommit, pointer } = await mount({ tl: keyed });
    const line = host.querySelector("[data-volume]")!;
    await pointer(line, "pointerdown", 300, false, { clientY: 20 });
    await pointer(line, "pointermove", 300, false, { clientY: 19 });
    await pointer(line, "pointermove", 300, false, { clientY: 18 });
    // the line's body is 23 px for 84 dB: 2 px up = +7.3 dB
    expect(host.textContent).toContain("+7.3 dB");
    expect(onLive).toHaveBeenCalledTimes(2);
    await pointer(line, "pointerup", 300, false, { clientY: 18 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]).toEqual([expect.anything(), "Volume"]);
    expect((onCommit.mock.calls[0][0] as NleTimeline).tracks.A1.items[0].gain_db).toBe(7.3);
    expect(host.textContent).not.toContain("dB");
    act(() => root.unmount());
  });

  it("⌥-click on the volume line adds a key there; then a drag moves the key nearest the pointer", async () => {
    const first = await mount({ tl: keyed });
    const pps = ppsOf(first.host.querySelector("[data-clip]")!, 100);
    await first.pointer(first.host.querySelector("[data-volume]")!, "pointerdown", 152 + 2 * pps, true);
    const added = first.onCommit.mock.calls[0][0] as NleTimeline;
    expect(added.tracks.A1.items[0].keys!.gain_db).toEqual([[50, 0, "linear"]]);
    act(() => first.root.unmount());

    const { host, root, onCommit, pointer } = await mount({ tl: added });
    const line = host.querySelector("[data-volume]")!;
    await pointer(line, "pointerdown", 152 + 3 * pps, false, { clientY: 20 });
    await pointer(line, "pointermove", 152 + 3 * pps, false, { clientY: 22 });
    await pointer(line, "pointerup", 152 + 3 * pps, false, { clientY: 22 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect((onCommit.mock.calls[0][0] as NleTimeline).tracks.A1.items[0].keys!.gain_db).toEqual([[50, -7.3, "linear"]]);
    act(() => root.unmount());
  });
});
