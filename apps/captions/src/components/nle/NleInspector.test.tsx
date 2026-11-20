// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NleAsk } from "@/lib/editor";
import { runAll, type NleRun } from "@/lib/nle/commands";
import { find, NO_MARKS, withKeys, type NleTimeline } from "@/lib/nle/model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bridge = vi.hoisted(() => ({
  queue: [] as unknown[],
  topics: new Map<string, () => void>(),
  addLut: vi.fn(),
}));
vi.mock("@/lib/editor", async (orig) => ({
  ...(await orig<typeof import("@/lib/editor")>()),
  nlePending: async () => ({ requests: bridge.queue.splice(0) }),
  nleReply: async () => {},
  listLuts: async () => [{ id: "lut_ab12", name: "Warm film", size: 33, bytes: 1, addedAt: 1 }],
  addLut: bridge.addLut,
}));
vi.mock("@/lib/sync", async (orig) => ({
  ...(await orig<typeof import("@/lib/sync")>()),
  clientId: "tab-1",
  onTopic: (topic: string, fn: () => void) => (bridge.topics.set(topic, fn), () => bridge.topics.delete(topic)),
}));
const { NleEditor } = await import("./NleEditor");
const { NleInspector } = await import("./NleInspector");

// a Tiny Acrobatics cut: one 4 s shot with its voice, from a file the camera tagged S-Log3
const cut = (camera?: object): NleTimeline => withKeys({
  timeline: { fps: 25, name: "Rolls" },
  sources: { a: { path: "/m/a.mp4", fps: 25, dur: 500, ...(camera ? { camera } : {}) } },
  tracks: { V1: { items: [{ src: "a", rec: 0, len: 100, in: 0, link: 1 }] }, A1: { items: [{ src: "a", rec: 0, len: 100, in: 0, link: 1 }] } },
} as unknown as NleTimeline);

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const key = (k: string, more: KeyboardEventInit = {}) => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...more })));
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const byLabel = <T extends Element = HTMLButtonElement>(l: string) => $<T>(`[aria-label="${l}"]`);
const click = async (el: Element) => {
  await act(async () => void el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
};
const typeIn = async (input: HTMLInputElement, v: string) => {
  await act(async () => input.focus());
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await flush();
};
const tabOf = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === name)!;
const menuItem = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')].find((b) => b.textContent?.includes(name))!;

let n = 0;
async function mount(start = cut()) {
  const changes: NleTimeline[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(
    <NleEditor initial={start} resetKey={`i${++n}`} urlOf={() => null} onSave={async () => {}} onChange={(now) => void changes.push(now)} />,
  ));
  await flush();
  const chat = async (commands: NleRun[]) => {
    bridge.queue.push({ id: `c${++n}`, edit: "e1", draft: "v2", kind: "run", commands } satisfies NleAsk);
    act(() => bridge.topics.get("nle:tab-1")!());
    await flush();
  };
  const seek = (seconds: number) => chat([{ id: "seek", params: { seconds } }]);
  await key("a", { metaKey: true, code: "KeyA" });
  await click(tabOf("Video"));
  return {
    now: () => changes.at(-1)!,
    v1: () => changes.at(-1)!.tracks.V1.items[0],
    chat, seek,
    done: () => { act(() => root.unmount()); host.remove(); },
  };
}

beforeEach(() => {
  bridge.queue.length = 0;
  bridge.addLut.mockReset();
  document.body.innerHTML = "";
  window.history.pushState({}, "", "/editor/e1/v2");
});

describe("Inspector keyframes", () => {
  it("◆ adds a key at the playhead, a keyed row keys where it is changed, values show at the playhead, ◆ on a key deletes it", async () => {
    const p = await mount();
    await click(byLabel("Zoom keyframe"));
    expect(p.v1().keys?.zoom).toEqual([[0, 1, "linear"]]);
    expect(byLabel("Zoom keyframe").getAttribute("aria-pressed")).toBe("true");
    await p.seek(2);
    expect(byLabel("Zoom keyframe").getAttribute("aria-pressed")).toBe("false");
    await typeIn(byLabel<HTMLInputElement>("Zoom X"), "1.5");
    expect(p.v1().keys?.zoom).toEqual([[0, 1, "linear"], [50, 1.5, "linear"]]);
    // halfway between the keys: valueAt
    await p.seek(1);
    expect(byLabel<HTMLInputElement>("Zoom X").value).toBe("1.250");
    // ▶ goes to the next key, where the value moves the key and ◆ is filled
    await click(byLabel("Zoom: next keyframe"));
    expect(byLabel("Zoom keyframe").getAttribute("aria-pressed")).toBe("true");
    await typeIn(byLabel<HTMLInputElement>("Zoom X"), "2");
    expect(p.v1().keys?.zoom).toEqual([[0, 1, "linear"], [50, 2, "linear"]]);
    await click(byLabel("Zoom keyframe"));
    expect(p.v1().keys?.zoom).toEqual([[0, 1, "linear"]]);
    p.done();
  });

  it("right-click ◆ sets the key's ease and deletes it, each one registry step", async () => {
    const p = await mount();
    await click(byLabel("Opacity keyframe"));
    await act(async () => void byLabel("Opacity keyframe").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 })));
    await flush();
    await click(menuItem("Hold"));
    expect(p.v1().keys?.opacity).toEqual([[0, 1, "hold"]]);
    await act(async () => void byLabel("Opacity keyframe").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 })));
    await flush();
    await click(menuItem("Delete"));
    expect(p.v1().keys).toBeUndefined();
    expect(p.v1().opacity).toBe(1);
    p.done();
  });
});

describe("Inspector camera", () => {
  it("lists the file's own curve only when it was read from the file; None keeps what the file said", async () => {
    let p = await mount();
    expect(document.body.textContent).not.toContain("(from the file)");
    expect(byLabel("Warm film")).toBeTruthy();
    await click(byLabel("F-Log2"));
    expect(p.now().sources.a.camera).toEqual({ curve: "flog2", on: true });
    await click(byLabel("Warm film"));
    expect(p.now().sources.a.camera).toEqual({ lut: "lut_ab12", on: true });
    p.done();

    p = await mount(cut({ curve: "slog3", from: "file", on: true }));
    expect(byLabel("S-Log3 (from the file)").getAttribute("aria-checked")).toBe("true");
    await click(byLabel("None"));
    expect(p.now().sources.a.camera).toEqual({ curve: "slog3", from: "file", on: false });
    await click(byLabel("S-Log3 (from the file)"));
    expect(p.now().sources.a.camera).toEqual({ curve: "slog3", from: "file", on: true });
    p.done();
  });

  it("Add LUT shows the route's own words when it is refused", async () => {
    bridge.addLut.mockRejectedValue(new Error("This .cube has a 1D shaper (LUT_1D_SIZE): export it as a 3D LUT only"));
    const p = await mount();
    const input = byLabel<HTMLInputElement>("LUT file");
    Object.defineProperty(input, "files", { value: [new File(["LUT_1D_SIZE 4"], "look.cube")], configurable: true });
    await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    expect(bridge.addLut).toHaveBeenCalledOnce();
    expect($('[role="alert"]').textContent).toBe("This .cube has a 1D shaper (LUT_1D_SIZE): export it as a 3D LUT only");
    p.done();
  });
});

describe("Inspector Color and History", () => {
  it("the Color panel writes the clip's grade, one step", async () => {
    vi.useFakeTimers();
    try {
      const p = await mount();
      await click(tabOf("Color"));
      const sat = [...document.querySelectorAll<HTMLInputElement>('input[type="range"]')].find((r) => r.closest("label")?.textContent?.startsWith("Sat"))!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(sat, "1.4");
        sat.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => void vi.advanceTimersByTime(400));
      expect(p.v1().grade).toMatchObject({ sat: 1.4 });
      p.done();
    } finally {
      vi.useRealTimers();
    }
  });

  it("History names the steps, marks the chat's, goes back on a click and greys the later ones until a new edit", async () => {
    const p = await mount();
    await click(byLabel("Zoom keyframe"));
    await p.chat([{ id: "setLength", params: { seconds: 6 } }]);
    await click(tabOf("History"));
    const rows = () => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="History"] button')];
    expect(rows().map((r) => r.textContent)).toEqual(["1Opened", "2Keyframe", "3Set the timeline's length: V1's last shot and its voice run on to it, or everything past it is cut"]);
    expect(rows()[2].querySelector('[aria-label="From the chat"]')).toBeTruthy();
    expect(rows()[1].querySelector('[aria-label="From the chat"]')).toBeNull();
    await click(rows()[1]);
    expect(p.v1().keys?.zoom).toBeTruthy();
    expect(p.now().tracks.V1.items[0].len).toBe(100);
    expect(rows()[1].getAttribute("aria-current")).toBe("step");
    expect(rows()[2].className).toContain("text-zinc-600");
    await click(rows()[0]);
    expect(p.v1().keys).toBeUndefined();
    // a new edit drops the grey ones
    await p.chat([{ id: "setLength", params: { seconds: 2 } }]);
    expect(rows()).toHaveLength(2);
    p.done();
  });
});

describe("Inspector transition", () => {
  // two shots, each with its voice; the later one starts 10 frames into the file (its head room), a centred dissolve on it
  const two = (): NleTimeline => {
    const tl = withKeys({
      timeline: { fps: 25 },
      sources: { a: { path: "/m/a.mp4", fps: 25, dur: 500 } },
      tracks: {
        V1: { items: [{ src: "a", rec: 0, len: 75, in: 0, link: 1 }, { src: "a", rec: 75, len: 75, in: 10, link: 2, trans: { type: "dissolve", len: 20, at: "center" } }] },
        A1: { items: [{ src: "a", rec: 0, len: 75, in: 0, link: 1 }, { src: "a", rec: 75, len: 75, in: 10, link: 2, trans: { type: "crossfade", len: 20, at: "center" } }] },
      },
    } as unknown as NleTimeline);
    return tl;
  };

  function Host({ start, onTl }: { start: NleTimeline; onTl: (tl: NleTimeline) => void }) {
    const [tl, setTl] = useState(start);
    const k = tl.tracks.V1.items[1]._k!;
    const set = (next: NleTimeline) => { setTl(next); onTl(next); };
    return (
      <NleInspector tl={tl} keys={[]} transKey={k} nameOf={() => "shot"} onLive={() => {}} onCommit={set}
        onRun={(list, on) => set(runAll({ tl, sel: on ?? [], trans: k, playhead: 0, marks: NO_MARKS }, list).tl)} />
    );
  }

  it("the model clamps a length to the handles at its alignment", () => {
    const tl = two();
    const k = tl.tracks.V1.items[1]._k!;
    const s = { tl, sel: [k], trans: k, playhead: 0, marks: NO_MARKS };
    expect(find(runAll(s, [{ id: "transition", params: { frames: 1000 } }]).tl, k)!.item.trans!.len).toBe(21);
    expect(find(runAll(s, [{ id: "transition", params: { frames: 1000, at: "end" } }]).tl, k)!.item.trans).toEqual({ type: "dissolve", len: 10, at: "end" });
  });

  it("type and alignment are radio lists, the linked sound follows, and Cross-fade sound turns its crossfade off and on", async () => {
    let now = two();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(<Host start={now} onTl={(t) => (now = t)} />));
    expect(byLabel("Cross Dissolve").getAttribute("aria-checked")).toBe("true");
    await click(byLabel("Dip to Black"));
    await click(byLabel("Start on Cut"));
    expect(now.tracks.V1.items[1].trans).toEqual({ type: "dip_black", len: 20, at: "start" });
    expect(now.tracks.A1.items[1].trans).toEqual({ type: "crossfade", len: 20, at: "start" });
    const sw = byLabel<HTMLInputElement>("Cross-fade sound");
    expect(sw.checked).toBe(true);
    await click(sw);
    expect(now.tracks.A1.items[1].trans).toBeUndefined();
    expect(now.tracks.V1.items[1].trans?.type).toBe("dip_black");
    await click(byLabel<HTMLInputElement>("Cross-fade sound"));
    expect(now.tracks.A1.items[1].trans).toEqual({ type: "crossfade", len: 20, at: "start" });
    act(() => root.unmount());
  });
});
