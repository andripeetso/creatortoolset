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
type NleProcessing = import("./NleInspector").NleProcessing;

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

describe("Inspector Autosaves", () => {
  it("lists the autosaves under the steps; picking one restores it as one step that undo takes back", async () => {
    const p = await mount();
    await p.chat([{ id: "setLength", params: { seconds: 6 } }]);
    await act(async () => void window.dispatchEvent(new Event("blur")));
    await flush();
    await p.chat([{ id: "setLength", params: { seconds: 2 } }]);
    await click(tabOf("History"));
    const saves = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Autosaves"] button')];
    expect(saves.map((b) => b.textContent)).toEqual([expect.stringMatching(/^just now.*Set the timeline's length/)]);
    await click(saves[0]);
    expect(p.v1().len).toBe(150);
    const steps = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="History"] button')];
    expect(steps.at(-1)!.textContent).toBe("4Restore autosave");
    await key("z", { metaKey: true, code: "KeyZ" });
    expect(p.v1().len).toBe(50);
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

describe("Inspector processing: the timeline's setting and a clip's own", () => {
  // two shots with their voices; the page offers "boost" on A1 only
  const two = (): NleTimeline => withKeys({
    timeline: { fps: 25, processing: { boost: 3 } },
    sources: { a: { path: "/m/a.mp4", fps: 25, dur: 500 } },
    tracks: {
      V1: { items: [{ src: "a", rec: 0, len: 75, in: 0 }, { src: "a", rec: 75, len: 75, in: 10 }] },
      A1: { items: [{ src: "a", rec: 0, len: 75, in: 0 }, { src: "a", rec: 75, len: 75, in: 10 }] },
      A2: { items: [{ src: "a", rec: 0, len: 150, in: 0 }] },
    },
  } as unknown as NleTimeline);
  const boost: NleProcessing = {
    name: "boost", title: "Boost", tab: "audio", def: 0, applies: (_it, track) => track === "A1",
    render: ({ value, mixed, set, readOnly }) => readOnly ? <span data-shown>{String(value)}</span> : (
      <input type="number" aria-label="Boost" data-mixed={mixed} defaultValue={String(value)} onChange={(ev) => set(Number(ev.target.value), false)}
        onBlur={(ev) => set(Number(ev.target.value), true)} />
    ),
  };
  const steps: { tl: NleTimeline; label?: string }[] = [];
  const lives: (NleTimeline | null)[] = [];
  function Host({ start, keys, readOnly }: { start: NleTimeline; keys: (tl: NleTimeline) => string[]; readOnly?: boolean }) {
    const [tl, setTl] = useState(start);
    const [sel] = useState(() => keys(start));
    return (
      <NleInspector tl={tl} keys={sel} nameOf={() => "shot"} onLive={(t) => void lives.push(t)} processing={[boost]} readOnly={readOnly}
        onCommit={(next, label) => { steps.push({ tl: next, label }); setTl(next); }} />
    );
  }
  const open = async (keys: (tl: NleTimeline) => string[], start = two(), readOnly = false) => {
    steps.length = 0;
    lives.length = 0;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(<Host start={start} keys={keys} readOnly={readOnly} />));
    await flush();
    await click(tabOf("Audio"));
    return () => act(() => root.unmount());
  };
  const radio = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === name)!;
  const a1 = (tl: NleTimeline) => tl.tracks.A1.items;
  const setNum = async (input: HTMLInputElement, v: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => void input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    await flush();
  };

  it("a clip follows the timeline, read only, until This clip only copies it; editing it is live then one step; Same as timeline takes it off", async () => {
    const done = await open((tl) => [a1(tl)[0]._k!]);
    expect(radio("Same as timeline").getAttribute("aria-checked")).toBe("true");
    expect($("[data-shown]").textContent).toBe("3");
    expect(document.querySelector('[aria-label="Boost"]')).toBeNull();
    await click(radio("This clip only"));
    expect(steps.at(-1)!.label).toBe("Boost: this clip only");
    expect(a1(steps.at(-1)!.tl)[0].processing).toEqual({ boost: 3 });
    expect(a1(steps.at(-1)!.tl)[1].processing).toBeUndefined();
    await setNum(byLabel<HTMLInputElement>("Boost"), "7");
    expect(a1(lives.at(-1)!)[0].processing).toEqual({ boost: 7 });
    expect(steps).toHaveLength(2);
    expect(a1(steps.at(-1)!.tl)[0].processing).toEqual({ boost: 7 });
    expect(steps.at(-1)!.tl.timeline.processing).toEqual({ boost: 3 });
    await click(radio("Same as timeline"));
    expect(steps).toHaveLength(3);
    expect(a1(steps.at(-1)!.tl)[0].processing).toBeUndefined();
    done();
  });

  it("Edit timeline setting opens the Timeline tab, where a change sets what every following clip plays", async () => {
    const done = await open((tl) => [a1(tl)[0]._k!]);
    await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Edit timeline setting")!);
    expect(tabOf("Timeline").getAttribute("aria-selected")).toBe("true");
    await setNum(byLabel<HTMLInputElement>("Boost"), "5");
    expect(steps.at(-1)!.tl.timeline.processing).toEqual({ boost: 5 });
    expect(steps.at(-1)!.label).toBe("Boost");
    done();
  });

  it("several clips: only the ones it applies to; different values show Mixed and a change sets them all", async () => {
    const start = two();
    a1(start)[1].processing = { boost: 9 };
    const done = await open((tl) => [...a1(tl), ...tl.tracks.A2.items].map((i) => i._k!), start);
    expect(radio("Same as timeline").getAttribute("aria-checked")).toBe("false");
    expect(radio("These clips only").getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain("Mixed");
    expect(byLabel("Boost").getAttribute("data-mixed")).toBe("true");
    await setNum(byLabel<HTMLInputElement>("Boost"), "4");
    const now = steps.at(-1)!.tl;
    expect(a1(now).map((i) => i.processing)).toEqual([{ boost: 4 }, { boost: 4 }]);
    expect(now.tracks.A2.items[0].processing).toBeUndefined();
    done();
  });

  it("no section when none of the selection applies; read only shows the values with no controls", async () => {
    let done = await open((tl) => [tl.tracks.A2.items[0]._k!]);
    expect(document.querySelector('[role="radiogroup"][aria-label="Boost setting"]')).toBeNull();
    done();
    // a clip moved off A1 with its own setting keeps the section, so it can follow the timeline again
    document.body.innerHTML = "";
    const moved = two();
    moved.tracks.A2.items[0].processing = { boost: 6 };
    done = await open((tl) => [tl.tracks.A2.items[0]._k!], moved);
    await click(radio("Same as timeline"));
    expect(steps.at(-1)!.tl.tracks.A2.items[0].processing).toBeUndefined();
    done();
    document.body.innerHTML = "";
    const start = two();
    a1(start)[0].processing = { boost: 8 };
    done = await open((tl) => [a1(tl)[0]._k!], start, true);
    expect(document.querySelector('[role="radio"]')).toBeNull();
    expect(document.body.textContent).toContain("This clip only");
    expect($("[data-shown]").textContent).toBe("8");
    expect(document.querySelector('[aria-label="Boost"]')).toBeNull();
    await click(tabOf("Timeline"));
    expect($("[data-shown]").textContent).toBe("3");
    done();
  });
});
