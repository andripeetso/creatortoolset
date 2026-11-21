// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WORK_PREFS } from "@contracts/work-prefs";
import type { NleAsk } from "@/lib/editor";
import { useWorkPrefs } from "@/lib/setup";
import { lengthOf, setItems, withKeys, type NleTimeline } from "@/lib/nle/model";
import { setAutosaveStore, type Ring } from "@/lib/nle/autosave";
import type { NleControl, NleFoot, NleSide } from "./NleEditor";
import { viewerBeside } from "./NleLayout";
import { useChatMode } from "@/lib/chat-mode";

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
// Design over the editor, and a text clip's design and PNG, stand-ins: what reaches them is what is checked
const designs = vi.hoisted(() => ({ made: [] as string[], grabbed: 0 }));
vi.mock("@/pages/DesignPage", () => ({
  DesignEditor: ({ onDone }: { onDone: () => void }) => <div role="dialog" aria-label="Design"><button type="button" onClick={onDone}>Done</button></div>,
}));
vi.mock("@/lib/nle/text-design", async (orig) => ({
  ...(await orig<typeof import("@/lib/nle/text-design")>()),
  makeText: async (words: string, w: number, h: number) => (designs.made.push(words), { kind: "design", design: "d1", frame: "p1", path: "/data/designs/u/d1/renders/0123456789abcdef0123.png", w, h }),
  grabFrame: async () => (designs.grabbed++, new File(["x"], "frame.jpg", { type: "image/jpeg" })),
  grabDesign: async () => ({ id: "d9", pages: [{ id: "p1", layers: [] }], pictures: [] }),
}));
vi.mock("@/lib/designs", async (orig) => ({ ...(await orig<typeof import("@/lib/designs")>()), getDesign: async () => ({ id: "d9", pages: [{ id: "p1", layers: [] }], pictures: [] }) }));
// what the page says (its toasts' titles)
const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock("sonner", async (orig) => {
  const m = await orig<typeof import("sonner")>();
  return { ...m, toast: Object.assign((t: unknown, o?: object) => (toasts.push(t), m.toast(t as string, o)), m.toast) };
});
// the Inspector's text panel, a stand-in: the redraw callback it took when last drawn
const textPanel = vi.hoisted(() => ({ onDrawn: null as null | ((s: unknown) => void) }));
vi.mock("./NleText", () => ({ NleText: ({ onDrawn }: { onDrawn: (s: unknown) => void }) => ((textPanel.onDrawn = onDrawn), <div aria-label="Text panel" />) }));
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

describe("beside the chats (chat mode)", () => {
  // the shot with an empty V2 and A2 above and below it
  const spare = withKeys({ ...tl, tracks: { ...tl.tracks, V2: { items: [] }, A2: { items: [] } } } as unknown as NleTimeline);
  const heads = (host: Element) => [...host.querySelectorAll("[data-head] span.font-mono")].map((e) => e.textContent);
  const shows = (host: Element, label: string) => !host.querySelector(`section[aria-label="${label}"]`)!.parentElement!.className.includes("hidden");
  afterEach(() => {
    useChatMode.setState({ on: false, shown: false });
    localStorage.clear();
  });

  it("gives the viewer the room: panels hidden, empty tracks and rarer tools left out, the page's bar and foot; All editing tools brings them, kept apart from outside chat mode", async () => {
    localStorage.setItem("ct-nle-panels", JSON.stringify({ media: true, inspector: false }));
    useChatMode.setState({ on: true, shown: true });
    const foots: NleFoot[] = [];
    const p = await mount(spare, { bin: <div />, bar: <span>Draft 2</span>, foot: (f) => (foots.push(f), <p>{f.changes} by you</p>) });
    expect(p.host.querySelector('[role="toolbar"][aria-label="Editor"]')?.textContent).toContain("Draft 2");
    expect(shows(p.host, "Inspector")).toBe(false);
    expect(heads(p.host)).toEqual(["V1", "A1"]);
    expect(p.host.querySelector('[aria-label="Trim"]')).toBeNull();
    expect(p.host.textContent).toContain("0 by you");
    await key("a", { metaKey: true, code: "KeyA" });
    await key("Backspace", { code: "Backspace" });
    expect(foots.at(-1)).toMatchObject({ changes: 1, dirty: true });

    const all = [...p.host.querySelectorAll("button")].find((b) => b.textContent === "All editing tools")!;
    expect(all.getAttribute("aria-pressed")).toBe("false");
    act(() => all.click());
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(shows(p.host, "Inspector")).toBe(true);
    expect(heads(p.host)).toEqual(["V2", "V1", "A1", "A2"]);
    expect(p.host.querySelector('[aria-label="Trim"]')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem("ct-nle-panels-chat")!)).toEqual({ media: true, inspector: true });
    // outside chat mode as it was: its own panels, no foot
    act(() => useChatMode.setState({ on: false, shown: false }));
    await flush();
    expect(JSON.parse(localStorage.getItem("ct-nle-panels")!)).toEqual({ media: true, inspector: false });
    expect(shows(p.host, "Inspector")).toBe(false);
    expect(p.host.textContent).not.toContain("by you");
    p.done();
  });

  it("the foot's save keeps the timeline and says so; with nothing changed it is done at once", async () => {
    useChatMode.setState({ on: true, shown: true });
    const onSave = vi.fn(async () => {});
    let last: NleFoot | null = null;
    const p = await mount(tl, { onSave, foot: (f) => ((last = f), null) });
    expect(await last!.save()).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    await key("a", { metaKey: true, code: "KeyA" });
    await key("Backspace", { code: "Backspace" });
    let ok = false;
    await act(async () => void (ok = await last!.save()));
    expect(ok).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(last!.dirty).toBe(false);
    p.done();
  });
});

describe("the side panel beside the viewer (chat mode)", () => {
  afterEach(() => {
    useChatMode.setState({ on: false, shown: false });
    localStorage.clear(); // the panels and Inspector tab opened here
  });

  it("a portrait cut's viewer is as wide as its frame drawn as tall as the row; a landscape one keeps the width unless there is room", () => {
    // a 1000 px row 600 tall: the 9:16 frame is (600 - 102) * 9/16 = 280 wide, 316 with its padding
    expect(viewerBeside({ w: 1000, h: 600 }, { w: 1080, h: 1920 })).toBe(316);
    expect(viewerBeside({ w: 1000, h: 300 }, { w: 1080, h: 1920 })).toBe(260);
    expect(viewerBeside({ w: 1000, h: 900 }, { w: 1080, h: 1920 })).toBe(485);
    // narrow: the portrait viewer gives way to the panel's least; too narrow for both: no panel
    expect(viewerBeside({ w: 600, h: 900 }, { w: 1080, h: 1920 })).toBe(340);
    expect(viewerBeside({ w: 500, h: 900 }, { w: 1080, h: 1920 })).toBeNull();
    // landscape: beside only with the room left over
    expect(viewerBeside({ w: 1000, h: 600 }, { w: 1920, h: 1080 })).toBeNull();
    expect(viewerBeside({ w: 1400, h: 600 }, { w: 1920, h: 1080 })).toBe(921);
  });

  it("gets the timeline, a hand edit as one undo step, and opens a part in the viewer as Source", async () => {
    useChatMode.setState({ on: true, shown: true });
    let s: NleSide | null = null;
    const foots: NleFoot[] = [];
    const p = await mount(tl, { side: (x) => ((s = x), null), foot: (f) => (foots.push(f), null) });
    expect(s!.tl.tracks.V1.items).toHaveLength(1);
    act(() => s!.source({ path: "/m/a.mp4", name: "Take 2", from: 2, to: 4 }));
    expect(p.host.querySelector('[aria-label="Viewer shows"] button[aria-pressed="true"]')?.textContent).toBe("source");
    const k = s!.tl.tracks.V1.items[0]._k!;
    act(() => s!.commit(setItems(s!.tl, [k], { in: 50 }), "Use take 2"));
    expect(foots.at(-1)).toMatchObject({ changes: 1, dirty: true });
    expect(p.now().tracks.V1.items[0].in).toBe(50);
    await key("z", { metaKey: true, code: "KeyZ" });
    expect(p.now().tracks.V1.items[0].in).toBe(0);
    // F9 lays the part the viewer opened on, as marked: 2 s to 4 s of the file
    await key("F9", { code: "F9" });
    expect(p.length()).toBe(125);
    p.done();
  });

  // the try: two shots in place of the one (`two`, below)
  const sideOf = async (more: Partial<Parameters<typeof NleEditor>[0]> = {}) => {
    useChatMode.setState({ on: true, shown: true });
    let s: NleSide | null = null;
    const p = await mount(tl, { side: (x) => ((s = x), null), ...more });
    return { p, s: () => s! };
  };
  const clips = (host: Element) => host.querySelectorAll('[data-clip][aria-label^="V1"]').length;

  it("a try shows on the timeline; Enter keeps it as one named undo step, the same as its own Keep", async () => {
    const { p, s } = await sideOf();
    act(() => s().preview(two, "Use take 3"));
    expect(s().trying).toBe(true);
    expect(clips(p.host)).toBe(2);
    expect(p.length()).toBe(75); // not an edit yet
    await key("Enter", { code: "Enter" });
    expect(s().trying).toBe(false);
    expect(p.length()).toBe(150);
    await key("z", { metaKey: true, code: "KeyZ" });
    expect(p.length()).toBe(75);
    // Keep in the panel does what Enter does
    act(() => s().preview(two, "Use take 3"));
    act(() => s().commitPreview());
    expect(s().trying).toBe(false);
    expect(p.length()).toBe(150);
    await key("z", { metaKey: true, code: "KeyZ" });
    expect(p.length()).toBe(75);
    p.done();
  });

  it("the kept try's step carries its name in History", async () => {
    const { p, s } = await sideOf();
    act(() => s().preview(two, "Use take 3"));
    act(() => s().commitPreview());
    await key("a", { metaKey: true, code: "KeyA" }); // a clip picked, so Video can be gone back to
    act(() => [...p.host.querySelectorAll("button")].find((b) => b.textContent === "All editing tools")!.click());
    const tab = (name: string) => act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === name)!.click());
    tab("History");
    expect([...p.host.querySelectorAll('[aria-label="History"] button')].map((b) => b.textContent)).toEqual(["1Opened", "2Use take 3"]);
    tab("Video"); // the Inspector opens on the tab last shown, in later tests too
    p.done();
  });

  it("Esc drops the try and keeps the picked clip; Enter in a text box does nothing", async () => {
    const { p, s } = await sideOf();
    await key("a", { metaKey: true, code: "KeyA" });
    expect(s().picked).toHaveLength(2);
    act(() => s().preview(two, "Use take 3"));
    expect(clips(p.host)).toBe(2);
    const box = p.host.appendChild(document.createElement("input"));
    await act(() => void box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })));
    expect(s().trying).toBe(true);
    box.remove();
    await key("Escape", { code: "Escape" });
    expect(s().trying).toBe(false);
    expect(clips(p.host)).toBe(1);
    expect(s().picked).toHaveLength(2);
    expect(p.length()).toBe(75);
    // with no try on, Esc lets the pick go as before
    await key("Escape", { code: "Escape" });
    expect(s().picked).toHaveLength(0);
    p.done();
  });

  it("⌘S and Save refuse while a try is on, saying how to end it", async () => {
    const onSave = vi.fn(async () => {});
    let last: NleFoot | null = null;
    const { p, s } = await sideOf({ onSave, foot: (f) => ((last = f), null) });
    act(() => s().preview(two, "Use take 3"));
    await key("s", { metaKey: true, code: "KeyS" });
    let ok = true;
    await act(async () => void (ok = await last!.save()));
    expect(ok).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
    expect(toasts.filter((t) => t === "Enter keeps the take you're trying, Esc drops it")).toHaveLength(2);
    await key("Enter", { code: "Enter" });
    await act(async () => void (ok = await last!.save()));
    expect(ok).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
    p.done();
  });

  it("with a try on, undo, redo and History take back only the try, never the edit under it; Save works again", async () => {
    const onSave = vi.fn(async () => {});
    let last: NleFoot | null = null;
    const { p, s } = await sideOf({ onSave, foot: (f) => ((last = f), null) });
    const trim = () => act(() => s().commit(setItems(s().tl, [s().tl.tracks.V1.items[0]._k!], { in: 50 }), "Trim"));
    const inNow = () => p.now().tracks.V1.items[0].in;
    trim();
    act(() => s().preview(two, "Use take 3"));
    await key("z", { metaKey: true, code: "KeyZ" });
    expect(s().trying).toBe(false);
    expect(inNow()).toBe(50); // the trim stays
    await key("z", { metaKey: true, code: "KeyZ" });
    expect(inNow()).toBe(0);
    // a redo with a try on drops the try and redoes nothing
    act(() => s().preview(two, "Use take 3"));
    await key("z", { metaKey: true, shiftKey: true, code: "KeyZ" });
    expect(s().trying).toBe(false);
    expect(inNow()).toBe(0);
    await key("z", { metaKey: true, shiftKey: true, code: "KeyZ" });
    expect(inNow()).toBe(50);
    // the Undo button the same
    act(() => s().preview(two, "Use take 3"));
    act(() => (p.host.querySelector('button[aria-label="Undo"]') as HTMLButtonElement).click());
    expect(s().trying).toBe(false);
    expect(inNow()).toBe(50);
    expect(clips(p.host)).toBe(1);
    let ok = false;
    await act(async () => void (ok = await last!.save()));
    expect(ok).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
    p.done();
  });

  it("while a try is on, edits on the timeline change nothing and the try stays: a blade, the panel's own edit, the chat", async () => {
    const { p, s } = await sideOf();
    act(() => s().seek(40));
    act(() => s().preview(two, "Use take 3"));
    toasts.length = 0;
    await key("w", { code: "KeyW" });
    act(() => s().commit(setItems(s().tl, [s().tl.tracks.V1.items[0]._k!], { in: 50 }), "Trim"));
    expect(toasts).toEqual(["Enter keeps the take you're trying, Esc drops it", "Enter keeps the take you're trying, Esc drops it"]);
    bridge.replies.length = 0;
    await p.deliver(ask({ id: "during-try", commands: [{ id: "setLength", params: { seconds: 1 } }] }));
    expect(bridge.replies[0].error).toContain("A take is being tried");
    expect(s().trying).toBe(true);
    expect(clips(p.host)).toBe(2);
    await key("Escape", { code: "Escape" });
    expect(clips(p.host)).toBe(1);
    expect(p.changes.at(-1)!.tracks.V1.items).toHaveLength(1);
    expect(p.now().tracks.V1.items[0].in).toBe(0);
    p.done();
  });

  it("Enter on a focused button and Esc in a menu or list are theirs, not the try's; a try started from a button lets go of its focus", async () => {
    const { p, s } = await sideOf();
    const take = p.host.appendChild(document.createElement("button"));
    take.focus();
    expect(document.activeElement).toBe(take);
    act(() => s().preview(two, "Use take 3"));
    expect(document.activeElement).not.toBe(take);
    const button = p.host.appendChild(document.createElement("button"));
    await act(() => void button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })));
    for (const role of ["menu", "listbox"]) {
      const el = p.host.appendChild(document.createElement("div"));
      el.setAttribute("role", role);
      await act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })));
      el.remove();
    }
    expect(s().trying).toBe(true);
    take.remove();
    button.remove();
    p.done();
  });

  it("a try the server's renders can't take stays on after Enter, saying why", async () => {
    const { p, s } = await sideOf({ renders: V1_ONLY });
    const louder = { ...two, tracks: { ...two.tracks, A1: { items: two.tracks.A1.items.map((i) => ({ ...i, norm_db: -3 })) } } } as NleTimeline;
    toasts.length = 0;
    act(() => s().preview(louder, "Use take 3"));
    await key("Enter", { code: "Enter" });
    expect(s().trying).toBe(true);
    expect(String(toasts[0])).toContain("Not in this server's renders yet");
    expect(p.length()).toBe(75);
    p.done();
  });

  it("Design on This Frame waits while a try is on", async () => {
    designs.grabbed = 0;
    const { p, s } = await sideOf({ urlOf: () => ({ url: "/m/a.mp4", grab: true }) });
    act(() => s().preview(two, "Use take 3"));
    toasts.length = 0;
    await rightClick(p.host.querySelector("[data-frame]")!);
    await act(() => menuItem("Design on This Frame").click());
    await flush();
    expect(designs.grabbed).toBe(0);
    expect(document.querySelector('[role="dialog"][aria-label="Design"]')).toBeNull();
    expect(toasts).toEqual(["Enter keeps the take you're trying, Esc drops it"]);
    p.done();
  });

  it("on Rendered, a try plays from the timeline; dropped, the render is back", async () => {
    const { p, s } = await sideOf({ rendered: { url: "/r/cut.mp4", first: true } });
    const render = () => p.host.querySelector('video[src="/r/cut.mp4"]');
    expect(render()).not.toBeNull();
    act(() => s().preview(two, "Use take 3"));
    expect(render()).toBeNull();
    await key("Escape", { code: "Escape" });
    expect(render()).not.toBeNull();
    p.done();
  });

  it("no text can be edited during a try; a text redraw already on its way lands and drops the try, saying so", async () => {
    const card = { kind: "design", design: "d1", frame: "p1", path: "/data/designs/u/d1/renders/a.png", w: 1080, h: 1920 };
    const texts = withKeys({ timeline: { fps: 25, name: "Card" }, sources: { t1: card }, tracks: { V1: { items: [{ src: "t1", rec: 0, len: 75, in: 0 }] } } } as unknown as NleTimeline);
    useChatMode.setState({ on: true, shown: true });
    let s: NleSide | null = null;
    const p = await mount(texts, { side: (x) => ((s = x), null) });
    act(() => [...p.host.querySelectorAll("button")].find((b) => b.textContent === "All editing tools")!.click());
    await key("a", { metaKey: true, code: "KeyA" });
    const panel = () => p.host.querySelector('[aria-label="Text panel"]');
    expect(panel()).not.toBeNull();
    const drawn = textPanel.onDrawn!; // what the panel holds for a change typed now
    act(() => s!.preview(two, "Use take 3"));
    expect(panel()).toBeNull();
    toasts.length = 0;
    act(() => drawn({ ...card, path: "/data/designs/u/d1/renders/b.png" }));
    expect(s!.trying).toBe(false);
    expect(p.now().sources.t1.path).toBe("/data/designs/u/d1/renders/b.png");
    expect(toasts).toEqual(["The text is drawn again: the take you were trying is dropped"]);
    p.done();
  });

  it("captions asked for before a try land and drop it, saying so", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    let made: (r: { project: string; clip: string }) => void = () => {};
    const send = () => new Promise<{ project: string; clip: string }>((r) => (made = r));
    const { p, s } = await sideOf({ captions: { send, open: () => {} } });
    await p.deliver(ask({ id: "captions-before-try", commands: [{ id: "makeCaptions" }] }));
    act(() => s().preview(two, "Use take 3"));
    toasts.length = 0;
    await act(async () => made({ project: "p1", clip: "c1" }));
    await flush();
    expect(s().trying).toBe(false);
    expect(p.now().captions).toMatchObject({ project: "p1", clip: "c1" });
    expect(toasts).toEqual(["The captions are in: the take you were trying is dropped"]);
    p.done();
    vi.restoreAllMocks();
  });

  it("seek moves the playhead and lets the pick go", async () => {
    const { p, s } = await sideOf();
    await key("a", { metaKey: true, code: "KeyA" });
    act(() => s().seek(40));
    await flush();
    expect(s().picked).toHaveLength(0);
    expect((await p.state()).playhead).toBe(40 / 25); // the chat is told seconds
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

// renders at version 1 that draw V1's zoom, tilt and fades and A1's level, and nothing else
const V1_ONLY = { edj_version: 1, tracks: { V1: ["zoom", "tilt", "fade_in", "fade_out"], A1: ["gain_db"] } };

describe("a server whose renders take timeline version 1", () => {
  it("greys the version-2 controls with the line, makes no version-2 edit from a key or the chat, and the rest still works", async () => {
    const p = await mount(two, { renders: V1_ONLY });
    // ⌘T would add a transition: nothing changes
    await key("t", { code: "KeyT", metaKey: true });
    expect(p.changes.at(-1)?.tracks.V1.items[1].trans).toBeUndefined();
    // the clip menu's Add Transition rows and Normalize are greyed with the line
    const later = p.host.querySelectorAll('[data-clip][aria-label^="V1"]')[1]!;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, right: 1000, width: 1000, top: 0, bottom: 40, height: 40, x: 0, y: 0, toJSON: () => ({}) });
    await rightClick(later, 1);
    rect.mockRestore();
    for (const row of ["Cross Dissolve", "Normalize Audio Levels…"]) {
      expect(menuItem(row).disabled).toBe(true);
      expect(menuItem(row).title).toBe("Not in this server's renders yet");
    }
    await key("Escape", { code: "Escape" });
    // picked clips: the Inspector's keyframe buttons are greyed with it
    await key("a", { code: "KeyA", metaKey: true });
    const diamonds = [...p.host.querySelectorAll<HTMLButtonElement>('button[aria-pressed][aria-label$=" keyframe"]')];
    expect(diamonds.length).toBeGreaterThan(0);
    expect(diamonds.every((b) => b.disabled && b.title === "Not in this server's renders yet")).toBe(true);
    // the chat: a keyframe is refused with why, a length change runs
    await p.deliver(ask({ id: "k1", commands: [{ id: "key", params: { prop: "zoom" } }] }));
    expect(bridge.replies.at(-1)).toEqual({ id: "k1", error: expect.stringContaining("Not in this server's renders yet") });
    await p.deliver(ask({ id: "t1", commands: [{ id: "newText", params: { words: "Tiny" } }] }));
    expect(bridge.replies.at(-1)).toEqual({ id: "t1", error: expect.stringContaining("Not in this server's renders yet") });
    expect(p.changes.some((t) => Object.values(t.tracks).some((x) => x.items.some((i) => i.keys)) || Object.values(t.sources).some((x) => x.kind === "design"))).toBe(false);
    await p.deliver(ask({ id: "l1", commands: [{ id: "setLength", params: { seconds: 8 } }] }));
    expect(bridge.replies.at(-1)).toEqual({ id: "l1", result: expect.objectContaining({ length: 8 }) });
    expect(p.length()).toBe(200);
    p.done();
  });

  it("greys each control whose field the renders don't draw on its clips' track, and refuses that edit from the chat", async () => {
    const p = await mount(two, { renders: V1_ONLY });
    await key("a", { code: "KeyA", metaKey: true });
    const greyed = (label: string) => !!p.host.querySelector(`fieldset[disabled][title="Not in this server's renders yet"] [title="${label}"]`);
    expect(greyed("Rotation Angle")).toBe(true);
    expect(greyed("Position")).toBe(true);
    expect(greyed("Opacity")).toBe(true);
    expect(greyed("Zoom")).toBe(false);
    expect(greyed("Fade in")).toBe(false);
    await p.deliver(ask({ id: "e1", commands: [{ id: "enable", params: {} }] }));
    expect(bridge.replies.at(-1)).toEqual({ id: "e1", error: "Not in this server's renders yet: V1 enabled, A1 enabled" });
    p.done();
  });

  it("where nothing is said of the renders nothing is greyed", async () => {
    const p = await mount(two);
    await key("t", { code: "KeyT", metaKey: true });
    expect(p.now().tracks.V1.items[1].trans).toBeTruthy();
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
    p.done();
  });
});

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

describe("text clips and Design on This Frame", () => {
  it("New Text from the ruler's menu lays a 5 s text clip at the playhead on V2 and fills in its design's PNG", async () => {
    designs.made.length = 0;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const p = await mount();
    await key("End", { code: "End" });
    await rightClick(p.host.querySelector('[title="The playhead"]')!.parentElement!.nextElementSibling!);
    await act(() => menuItem("New Text").click());
    await flush();
    expect(p.now().tracks.V2!.items).toEqual([expect.objectContaining({ src: "text1", rec: 74, len: 125, in: 0 })]);
    expect(p.now().sources.text1).toEqual({ kind: "design", design: "d1", frame: "p1", path: "/data/designs/u/d1/renders/0123456789abcdef0123.png", w: 1080, h: 1920 });
    expect(designs.made).toEqual([""]);
    // one undo step takes it away, and a redo brings it back made, never making it twice
    await key("z", { metaKey: true, code: "KeyZ" });
    expect(p.now().tracks.V2?.items ?? []).toEqual([]);
    await key("z", { metaKey: true, shiftKey: true, code: "KeyZ" });
    await flush();
    expect(p.now().sources.text1!.path).toMatch(/\.png$/);
    expect(designs.made).toHaveLength(1);
    p.done();
    vi.restoreAllMocks();
  });

  it("is greyed on a catalog original; on a blurred or own file it opens Design over the editor, whose keys are its own", async () => {
    // the page marks only what may be drawn into a design: a file it doesn't mark (a catalog original) is never grabbed
    const p = await mount(tl, { urlOf: () => ({ url: "/m/a.mp4" }) });
    await rightClick(p.host.querySelector("[data-frame]")!);
    expect(menuItem("Design on This Frame").disabled).toBe(true);
    p.done();
    designs.grabbed = 0;
    const q = await mount(tl, { urlOf: () => ({ url: "/m/a.mp4", grab: true }) });
    await rightClick(q.host.querySelector("[data-frame]")!);
    expect(menuItem("Design on This Frame").disabled).toBe(false);
    await act(() => menuItem("Design on This Frame").click());
    await flush();
    expect(designs.grabbed).toBe(1);
    expect(document.querySelector('[role="dialog"][aria-label="Design"]')).not.toBeNull();
    // M (a marker) and ⌘A Backspace (delete everything) stay the designer's while it is open
    await key("m", { code: "KeyM" });
    await key("a", { metaKey: true, code: "KeyA" });
    await key("Backspace", { code: "Backspace" });
    expect(q.now().markers ?? []).toEqual([]);
    expect(q.length()).toBe(75);
    // Done with nothing designed on the frame lays nothing; the editor's keys are back
    await act(() => (document.querySelector('[aria-label="Design"] button') as HTMLButtonElement).click());
    await flush();
    expect(document.querySelector('[aria-label="Design"]')).toBeNull();
    expect(Object.keys(q.now().tracks)).toEqual(["V1", "A1"]);
    await key("m", { code: "KeyM" });
    expect(q.now().markers).toHaveLength(1);
    q.done();
  });
});
