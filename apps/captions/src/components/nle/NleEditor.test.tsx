// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORK_PREFS } from "@contracts/work-prefs";
import type { NleAsk } from "@/lib/editor";
import { useWorkPrefs } from "@/lib/setup";
import { lengthOf, withKeys, type NleTimeline } from "@/lib/nle/model";
import { setAutosaveStore, type Ring } from "@/lib/nle/autosave";
import type { NleControl } from "./NleEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A fake bridge: the requests the server would hand this window (each GET takes them), the replies posted, and the topic
// the page listens on, fired by hand.
const bridge = vi.hoisted(() => ({
  queue: [] as unknown[],
  replies: [] as Array<{ id: string; result?: unknown; error?: string }>,
  topics: new Map<string, () => void>(),
}));
vi.mock("@/lib/editor", async (orig) => ({
  ...(await orig<typeof import("@/lib/editor")>()),
  nlePending: async () => ({ requests: bridge.queue.splice(0) }),
  nleReply: async (r: { id: string }) => void bridge.replies.push(r),
  listLuts: async () => [],
  getEditSteps: async () => ({ steps: [{ id: "colour", state: "on", use: true, values: {} }], canAdd: false }),
}));
const saved = vi.hoisted(() => ({ files: [] as Array<[string, string]> }));
vi.mock("@/lib/download", () => ({ downloadText: (name: string, text: string) => void saved.files.push([name, text]), downloadBlob: () => {} }));
vi.mock("@/lib/sync", async (orig) => ({
  ...(await orig<typeof import("@/lib/sync")>()),
  clientId: "tab-1",
  onTopic: (topic: string, fn: () => void) => (bridge.topics.set(topic, fn), () => bridge.topics.delete(topic)),
}));
const { NleEditor } = await import("./NleEditor");

// a Tiny Acrobatics cut: one 3 s shot with its voice
const tl: NleTimeline = withKeys({
  timeline: { fps: 25, name: "Rolls" },
  sources: { a: { path: "/m/a.mp4", fps: 25, dur: 500 } },
  tracks: { V1: { items: [{ src: "a", rec: 0, len: 75, in: 0, link: 1 }] }, A1: { items: [{ src: "a", rec: 0, len: 75, in: 0, link: 1 }] } },
} as unknown as NleTimeline);

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const key = (k: string, more: KeyboardEventInit = {}) => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...more })));
const ask = (a: Partial<NleAsk> & { id: string }): NleAsk => ({ edit: "e1", draft: "v2", kind: "run", ...a });

let n = 0;
async function mount(initial = tl, more: Partial<Parameters<typeof NleEditor>[0]> = {}) {
  const changes: NleTimeline[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(
    <NleEditor initial={initial} resetKey={`t${++n}`} urlOf={() => null} onSave={async () => {}} onChange={(now) => void changes.push(now)} {...more} />,
  ));
  await flush();
  const deliver = async (...asks: NleAsk[]) => {
    bridge.queue.push(...asks);
    act(() => bridge.topics.get("nle:tab-1")!());
    await flush();
  };
  const state = async () => {
    bridge.replies.length = 0;
    await deliver(ask({ id: `s${++n}`, kind: "state" }));
    return bridge.replies[0].result as { playhead: number };
  };
  return { host, changes, now: () => changes.at(-1)!, length: () => lengthOf(changes.at(-1)!), deliver, state, done: () => act(() => root.unmount()) };
}

beforeEach(() => {
  useWorkPrefs.setState({ prefs: { ...DEFAULT_WORK_PREFS } });
  bridge.queue.length = 0;
  bridge.replies.length = 0;
  window.history.pushState({}, "", "/editor/e1/v2");
});

describe("the chat's editor commands on the page", () => {
  it("takes the requests waiting when it opens, and answers state with the timeline as it is", async () => {
    bridge.queue.push(ask({ id: "s1", kind: "state" }));
    const p = await mount();
    expect(bridge.replies).toEqual([{ id: "s1", result: expect.objectContaining({ length: 3, selection: [] }) }]);
    p.done();
  });

  it("runs a list as one undo step, answers it, never twice for one request, and undo takes it back", async () => {
    const p = await mount();
    expect(p.length()).toBe(75);
    const run = ask({ id: "r1", commands: [{ id: "setLength", params: { seconds: 5 } }, { id: "seek", params: { seconds: 1 } }] });
    await p.deliver(run);
    expect(p.length()).toBe(125);
    expect(bridge.replies).toEqual([{ id: "r1", result: expect.objectContaining({ length: 5, playhead: 1 }) }]);
    // the same request again: not run again
    await p.deliver(run);
    expect(bridge.replies).toHaveLength(1);
    const seen = p.changes.length;
    // ⌘Z: the whole list in one step, and nothing before it
    await key("z", { metaKey: true, code: "KeyZ" });
    expect(p.length()).toBe(75);
    await key("z", { metaKey: true, code: "KeyZ" });
    expect(p.changes.length).toBe(seen + 1);
    p.done();
  });

  it("answers a request for another draft, and a wrong command with what is wrong, changing nothing", async () => {
    const p = await mount();
    await p.deliver(ask({ id: "x1", draft: "v3", commands: [{ id: "setLength", params: { seconds: 9 } }] }), ask({ id: "x2", commands: [{ id: "nudgeOn" }] }));
    expect(bridge.replies).toEqual([
      { id: "x1", error: "This window has draft v2 of edit e1 open, not draft v3 of edit e1." },
      { id: "x2", error: expect.stringContaining("Command 1 (nudgeOn): nothing to do it on") },
    ]);
    expect(p.length()).toBe(75);
    p.done();
  });

  it("runs the keys through the same commands: ⌘A then Backspace deletes, ⌘Z brings it back", async () => {
    const p = await mount();
    await key("a", { metaKey: true, code: "KeyA" });
    await key("Backspace", { code: "Backspace" });
    expect(p.length()).toBe(0);
    await key("z", { metaKey: true, code: "KeyZ" });
    expect(p.length()).toBe(75);
    p.done();
  });
});

// two Tiny Acrobatics shots cut together, each with its voice
const two: NleTimeline = withKeys({
  timeline: { fps: 25, name: "Rolls" },
  sources: { a: { path: "/m/a.mp4", fps: 25, dur: 500 } },
  tracks: {
    V1: { items: [{ src: "a", rec: 0, len: 75, in: 0, link: 1 }, { src: "a", rec: 75, len: 75, in: 200, link: 2 }] },
    A1: { items: [{ src: "a", rec: 0, len: 75, in: 0, link: 1 }, { src: "a", rec: 75, len: 75, in: 200, link: 2 }] },
  },
} as unknown as NleTimeline);
const typeIn = (el: Element, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const menuItem = (name: string) => [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent?.startsWith(name)) as HTMLButtonElement;
const rightClick = (el: Element, clientX = 300) => act(() => void el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY: 10 })));

describe("markers, transitions, lift and extract on the page", () => {
  it("M adds a marker at the playhead; M on it opens its name, colour, note and duration; ⇧↑ ⇧↓ go to markers", async () => {
    const p = await mount();
    await key("End", { code: "End" });
    await key("m", { code: "KeyM" });
    expect(p.now().markers).toEqual([{ frame: 74, name: "Marker 1", color: "Blue" }]);
    await key("m", { code: "KeyM" });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("0:02:24");
    // keys typed in it stay in it
    const name = dialog.querySelector("input")!;
    await typeIn(name, "Hook ends");
    await act(() => void name.dispatchEvent(new KeyboardEvent("keydown", { key: "m", code: "KeyM", bubbles: true })));
    expect(p.now().markers).toHaveLength(1);
    await act(() => (dialog.querySelector('[aria-label="Lavender"]') as HTMLButtonElement).click());
    await typeIn(dialog.querySelector("textarea")!, "the breath");
    await typeIn(dialog.querySelector('input[type="number"]')!, "10");
    await act(() => ([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Done") as HTMLButtonElement).click());
    expect(p.now().markers).toEqual([{ frame: 74, name: "Hook ends", color: "Lavender", note: "the breath", dur: 10 }]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await key("Home", { code: "Home" });
    await key("ArrowDown", { code: "ArrowDown", shiftKey: true });
    expect((await p.state()).playhead).toBe(2.96);
    await key("ArrowUp", { code: "ArrowUp", shiftKey: true });
    expect((await p.state()).playhead).toBe(2.96);
    p.done();
  });

  it("the ruler's menu: Add Marker, and Export Markers… saves them as a CSV", async () => {
    saved.files.length = 0;
    const p = await mount();
    const ruler = p.host.querySelector('[title="The playhead"]')!.parentElement!.nextElementSibling!;
    await rightClick(ruler);
    expect(menuItem("Export Markers…").disabled).toBe(true);
    await act(() => menuItem("Add Marker").click());
    await rightClick(ruler);
    await act(() => menuItem("Export Markers…").click());
    expect(saved.files).toEqual([["Rolls Markers.csv", "Timecode,Name,Colour,Note,Duration\n00:00:00:00,Marker 1,Blue,,00:00:00:01\n"]]);
    p.done();
  });

  it("⌘T adds a 1 s cross dissolve at the nearest cut, the voice a crossfade; a right-click at the cut adds a dip", async () => {
    const p = await mount(two);
    await key("t", { code: "KeyT", metaKey: true });
    expect(p.now().tracks.V1.items[1].trans).toEqual({ type: "dissolve", len: 25, at: "center" });
    expect(p.now().tracks.A1.items[1].trans).toEqual({ type: "crossfade", len: 25, at: "center" });
    await key("z", { metaKey: true, code: "KeyZ" });
    const later = p.host.querySelectorAll('[data-clip][aria-label^="V1"]')[1]!;
    // happy-dom lays out nothing: every box 0–1000 px, so a press at 1 px is at the clip's start, the cut
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, right: 1000, width: 1000, top: 0, bottom: 40, height: 40, x: 0, y: 0, toJSON: () => ({}) });
    await rightClick(later, 1);
    rect.mockRestore();
    await act(() => menuItem("Dip to White").click());
    expect(p.now().tracks.V1.items[1].trans?.type).toBe("dip_white");
    // a double click on its band picks it, Escape lets it go (Backspace then has nothing to take), picked again Backspace takes it off
    const band = () => p.host.querySelector('[data-lane="V1"] [data-trans]')!;
    const press = () => act(() => void band().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await press();
    expect(band().getAttribute("aria-pressed")).toBe("true");
    await key("Escape", { code: "Escape" });
    await key("Backspace", { code: "Backspace" });
    expect(p.now().tracks.V1.items[1].trans?.type).toBe("dip_white");
    await press();
    await key("Backspace", { code: "Backspace" });
    expect(p.now().tracks.V1.items[1].trans).toBeUndefined();
    expect(p.now().tracks.A1.items[1].trans).toBeUndefined();
    p.done();
  });

  it("In and Out with nothing picked: Backspace lifts the range, Delete extracts it", async () => {
    const p = await mount();
    for (let i = 0; i < 10; i++) await key("ArrowRight", { code: "ArrowRight" });
    await key("i", { code: "KeyI" });
    for (let i = 0; i < 10; i++) await key("ArrowRight", { code: "ArrowRight" });
    await key("o", { code: "KeyO" });
    await key("Backspace", { code: "Backspace" });
    expect(p.now().tracks.V1.items.map((i) => [i.rec, i.len])).toEqual([[0, 10], [21, 54]]);
    expect(p.length()).toBe(75);
    await key("z", { metaKey: true, code: "KeyZ" });
    await key("Delete", { code: "Delete" });
    expect(p.length()).toBe(64);
    p.done();
  });

  it("a clip laid from the bin gets the camera curve its file names on its source, on while the Colour step is on", async () => {
    const file = new Uint8Array([0, 0, 0, 16, ...new TextEncoder().encode("uuid"), 0, 0, 0, 0, 0, 0, 0, 0,
      ...((x: Uint8Array) => [0, 0, (x.length + 8) >> 8, (x.length + 8) & 255, ...new TextEncoder().encode("uuid"), ...x])(new TextEncoder().encode(
        '<AcquisitionRecord><Group name="CameraUnitMetadataSet"><Item name="CaptureGammaEquation" value="s-log3-cine"/><Item name="CaptureColorPrimaries" value="s-gamut3-cine"/></Group></AcquisitionRecord>'))]);
    const get = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const [a, b] = String((init?.headers as Record<string, string>).Range).slice(6).split("-").map(Number);
      return a >= file.length ? new Response(null, { status: 416 }) : new Response(file.slice(a, b + 1), { status: 206 });
    });
    vi.stubGlobal("fetch", get);
    const control = { current: null as NleControl | null };
    const p = await mount(tl, { control, urlOf: (src, t) => ({ url: `ctlocal://media${t.sources[src].path}` }) });
    await act(async () => control.current!.put({ path: "/m/slog.mp4", name: "slog", seconds: 2, fps: 25 }));
    for (let i = 0; i < 5; i++) await flush();
    const src = Object.values(p.now().sources).find((x) => x.path === "/m/slog.mp4")!;
    expect(src.camera).toEqual({ curve: "slog3", from: "file", on: true });
    vi.unstubAllGlobals();
    p.done();
  });
});

describe("autosaves", () => {
  const disk = new Map<string, Ring>();
  const puts: Ring[] = [];
  const store = () => setAutosaveStore({ get: async (k) => structuredClone(disk.get(k)), put: async (k, r) => void (puts.push(r), disk.set(k, structuredClone(r))) });
  const longer = (id: string, seconds: number) => ask({ id, commands: [{ id: "setLength", params: { seconds } }] });
  const blur = async () => { act(() => void window.dispatchEvent(new Event("blur"))); await flush(); };
  const wait = async (ms: number) => { act(() => void vi.advanceTimersByTime(ms)); await flush(); };
  beforeEach(() => { disk.clear(); puts.length = 0; store(); });
  afterEach(() => { vi.useRealTimers(); setAutosaveStore(); });

  it("write the live one a moment after each change, seal it every 30 s and on leaving the window, only when it changed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const p = await mount(tl, { resetKey: "tiny/a1" });
    const ring = () => puts.at(-1)!.list.map((a) => `${lengthOf(a.tl)}${a.live ? "*" : ""}`);
    await wait(60_000);
    expect(puts).toHaveLength(0);
    await p.deliver(longer("a1", 5));
    await wait(500);
    expect(puts).toHaveLength(0);
    await wait(500);
    expect(ring()).toEqual(["125*"]);
    await wait(29_000); // the 30 s tick seals it
    expect(ring()).toEqual(["125"]);
    await wait(90_000); // nothing changed since
    expect(puts).toHaveLength(2);
    await p.deliver(longer("a2", 4));
    await wait(1_000);
    await p.deliver(longer("a3", 6));
    await wait(1_000);
    expect(ring()).toEqual(["125", "150*"]);
    await blur();
    expect(ring()).toEqual(["125", "150"]);
    await blur();
    expect(puts).toHaveLength(5);
    p.done();
    expect(puts).toHaveLength(5);
  });

  it("a crash a second after a change loses nothing: the reopen gives it back with no 30 s wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const p = await mount(tl, { resetKey: "tiny/a4" });
    await p.deliver(longer("d1", 5));
    await wait(1_000);
    const crashed = structuredClone(disk.get("tiny/a4"));
    p.done();
    disk.set("tiny/a4", crashed!); // nothing written on closing: the app was gone
    store();
    const again = await mount(tl, { resetKey: "tiny/a4" });
    expect(again.length()).toBe(125);
    again.done();
  });

  it("a reopen gives the unsaved edits back, on that same timeline only and never from before a save", async () => {
    let p = await mount(tl, { resetKey: "tiny/a2" });
    await p.deliver(longer("b1", 5));
    p.done(); // closing takes one
    await flush();
    store(); // a reload: only what is on disk
    p = await mount(tl, { resetKey: "tiny/a2" });
    expect(p.length()).toBe(125);
    p.done();
    const other = withKeys({ ...tl, timeline: { fps: 25, name: "Flips" } } as NleTimeline);
    p = await mount(other, { resetKey: "tiny/a2" });
    expect(p.length()).toBe(75);
    p.done();
    p = await mount(tl, { resetKey: "tiny/a2" });
    expect(p.length()).toBe(125);
    await key("s", { metaKey: true, code: "KeyS" });
    await flush();
    p.done();
    await flush();
    p = await mount(tl, { resetKey: "tiny/a2" });
    expect(p.length()).toBe(75);
    expect(disk.get("tiny/a2")!.list).toHaveLength(1); // still there to restore by hand
    p.done();
  });

  it("with storage refused, editing and undo go on", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const no = () => { throw new Error("QuotaExceededError"); };
    setAutosaveStore({ get: no, put: no });
    const p = await mount(tl, { resetKey: "tiny/a3" });
    await p.deliver(longer("c1", 5));
    await blur();
    await wait(30_000);
    await p.deliver(longer("c2", 6));
    expect(p.length()).toBe(150);
    await key("z", { metaKey: true, code: "KeyZ" });
    expect(p.length()).toBe(125);
describe("the person's own keys (Keyboard Customization)", () => {
  it("a key changed there runs its command, the old one runs nothing, and the clip's menu shows the new key", async () => {
    useWorkPrefs.setState({ prefs: { ...DEFAULT_WORK_PREFS, keys: { "⌘A": "", G: "selectAll", R: "delete", Backspace: "" } } });
    const p = await mount();
    await key("a", { metaKey: true, code: "KeyA" });
    await key("r", { code: "KeyR" });
    expect(p.length()).toBe(75);
    await key("g", { code: "KeyG" });
    await key("Backspace", { code: "Backspace" });
    expect(p.length()).toBe(75);
    await key("r", { code: "KeyR" });
    expect(p.length()).toBe(0);
    await key("z", { metaKey: true, code: "KeyZ" });
    await rightClick(p.host.querySelector('[data-clip][aria-label^="V1"]')!);
    expect(menuItem("Delete").textContent).toBe("DeleteR");
    expect(menuItem("Cut").textContent).toBe("Cut⌘X");
    // ⌥⌘K opens Keyboard Customization
    await key("˚", { metaKey: true, altKey: true, code: "KeyK" });
    expect(document.body.textContent).toContain("Keyboard Customization");
    p.done();
  });
});
