// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withKeys, type NleTimeline } from "@/lib/nle/model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The Captions lane (F13): the timeline's captions are a Caption Studio clip, read from Caption Studio and drawn by its
// own renderer; Make / Update Captions are the page's (its render), the lane shows the cues and opens Caption Studio.
const topics = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@/lib/editor", async (orig) => ({ ...(await orig<typeof import("@/lib/editor")>()), nlePending: async () => ({ requests: [] }), nleReply: async () => {} }));
vi.mock("@/lib/sync", async (orig) => ({
  ...(await orig<typeof import("@/lib/sync")>()),
  clientId: "tab-1",
  onTopic: (topic: string, fn: () => void) => (topics.set(topic, fn), () => topics.delete(topic)),
}));
const { NleEditor } = await import("./NleEditor");

const tl: NleTimeline = withKeys({
  timeline: { fps: 25, name: "Rolls", width: 1080, height: 1920 },
  sources: { a: { path: "/m/a.mp4", fps: 25, dur: 500 } },
  tracks: { V1: { items: [{ src: "a", rec: 0, len: 75, in: 0, link: 1 }] }, A1: { items: [{ src: "a", rec: 0, len: 75, in: 0, link: 1 }] } },
} as unknown as NleTimeline);
const LINK = { project: "p1", clip: "c1", burn: false, from: [[0, 75, "a", 0]] as [number, number, string, number][] };
const words = [{ id: 1, text: "Tiny", start: 0, end: 0.4 }, { id: 2, text: "acrobats", start: 0.4, end: 1 }];
const CLIP = { id: "c1", name: "Rolls", duration: 3, srcWidth: 1080, srcHeight: 1920, cues: [{ id: 1, start: 0, end: 1, words }], style: {} };

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const text = (el: Element) => el.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => text(b) === label);
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function mount(initial: NleTimeline, captions?: { send: () => Promise<{ project: string; clip: string }>; open: (href: string) => void }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/projects/p1") ? { id: "p1", clips: [CLIP] } : {}), { status: 200 })));
  const changes: NleTimeline[] = [];
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<NleEditor initial={initial} resetKey={`k${Math.random()}`} urlOf={() => null} onSave={async () => {}} onChange={(now) => void changes.push(now)} captions={captions} />));
  await flush();
  return changes;
}

describe("the Captions lane", () => {
  it("is there only when the page can make captions", async () => {
    await mount(tl);
    expect(button("Make Captions")).toBeUndefined();
  });

  it("Make Captions sends the saved cut and links its Caption Studio clip; the cues show on the lane and over the picture", async () => {
    const send = vi.fn(async () => ({ project: "p1", clip: "c1" }));
    const open = vi.fn();
    const changes = await mount(tl, { send, open });
    await act(async () => button("Make Captions")!.click());
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(changes.at(-1)!.captions).toEqual(LINK);
    const cue = document.querySelector("[data-cue='1']")!;
    expect(text(cue)).toBe("Tiny acrobats");
    // Caption Studio's renderer over the viewer's frame, at the playhead (0 s)
    expect(text(document.querySelector("[data-frame]")!)).toContain("Tiny");
    await act(async () => void cue.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(open).toHaveBeenCalledWith("/captions?project=p1&clip=c1");
    await act(async () => button("Burn In")!.click());
    expect(changes.at(-1)!.captions!.burn).toBe(true);
  });

  it("from an older cut: the badge and Update Captions, and no captions over the picture", async () => {
    const send = vi.fn(async () => ({ project: "p1", clip: "c2" }));
    const older = { ...tl, captions: { ...LINK, from: [[0, 50, "a", 0]] as [number, number, string, number][] } };
    const changes = await mount(older, { send, open: () => {} });
    expect(document.body.textContent).toContain("From an older cut");
    expect(text(document.querySelector("[data-frame]")!)).not.toContain("Tiny");
    await act(async () => button("Update Captions")!.click());
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(changes.at(-1)!.captions).toEqual({ ...LINK, clip: "c2" });
    expect(document.body.textContent).not.toContain("From an older cut");
  });

  it("with the AI Editor's caption cards on the timeline, says that Burn In replaces them in renders", async () => {
    const line = "Replaces the caption cards in renders";
    await mount({ ...tl, captions: LINK }, { send: async () => ({ project: "p1", clip: "c1" }), open: () => {} });
    expect(document.body.textContent).not.toContain(line);
    document.body.innerHTML = "";
    const cards = { ...tl, captions: LINK, tracks: { ...tl.tracks, V4: { name: "CAPTIONS", items: [{ src: "a", rec: 0, len: 25, in: 0, _k: "k4" }] } } } as NleTimeline;
    const changes = await mount(cards, { send: async () => ({ project: "p1", clip: "c1" }), open: () => {} });
    expect(document.body.textContent).toContain(line);
    await act(async () => button("Burn In")!.click());
    // the cards stay in the timeline
    expect(changes.at(-1)!.tracks.V4).toEqual(cards.tracks.V4);
    expect(changes.at(-1)!.captions!.burn).toBe(true);
  });
});
