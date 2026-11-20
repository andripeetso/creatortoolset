// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NleAsk } from "@/lib/editor";
import { lengthOf, withKeys, type NleTimeline } from "@/lib/nle/model";

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
}));
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
async function mount() {
  const changes: NleTimeline[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(
    <NleEditor initial={tl} resetKey={`t${++n}`} urlOf={() => null} onSave={async () => {}} onChange={(now) => void changes.push(now)} />,
  ));
  await flush();
  const deliver = async (...asks: NleAsk[]) => {
    bridge.queue.push(...asks);
    act(() => bridge.topics.get("nle:tab-1")!());
    await flush();
  };
  return { changes, length: () => lengthOf(changes.at(-1)!), deliver, done: () => act(() => root.unmount()) };
}

beforeEach(() => {
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
