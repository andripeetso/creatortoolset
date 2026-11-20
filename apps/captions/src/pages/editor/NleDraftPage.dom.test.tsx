// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft, Edit, Timeline } from "@contracts/editor";
import type { NleAsk } from "@/lib/editor";
import { fromNle } from "@/lib/nle/draft";
import type { NleTimeline } from "@/lib/nle/model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// a Tiny Acrobatics draft: one 3 s shot with its voice, and a field the AI wrote on it
const timeline: Timeline = {
  name: "Rolls v1", fps: 25, width: 1080, height: 1920,
  sources: { ver_a: { versionId: "ver_a", name: "Roll", fps: 25, tc: 0, dur: 500, w: 1080, h: 1920 } },
  tracks: {
    V1: { name: "Speaker", items: [{ src: "ver_a", in: 0, len: 75, rec: 0, link: "l", line: "Roll forward" } as never] },
    V2: { name: "B-roll", items: [] },
    A1: { name: "Voice", items: [{ src: "ver_a", in: 0, len: 75, rec: 0, link: "l" }] },
    A2: { name: "Music", items: [] },
    A3: { name: "Sound effects", items: [] },
  },
  markers: [],
};
const fake = vi.hoisted(() => ({
  queue: [] as unknown[],
  replies: [] as Array<{ id: string; result?: unknown; error?: string }>,
  topics: new Map<string, () => void>(),
  saved: [] as Array<[string, string, NleTimeline]>,
  draft: null as unknown as Draft,
}));
const SOUND = ["gain_db", "fade_in", "fade_out", "enabled", "mute"];
const renders = { edj_version: 1, tracks: { V1: ["zoom", "tilt", "fade_in", "fade_out", "enabled"], V2: ["zoom", "tilt", "enabled", "hidden"], A1: SOUND, A2: SOUND, A3: SOUND } };
vi.mock("@/lib/editor", async (orig) => ({
  ...(await orig<typeof import("@/lib/editor")>()),
  getEdit: async () => ({ id: "e1", name: "Rolls", jobs: [], plans: [], previews: {}, marks: {} }) as unknown as Edit,
  getDraft: async () => fake.draft,
  saveTimeline: async (id: string, name: string, tl: NleTimeline) => (fake.saved.push([id, name, tl]), { id: "e1", name: "Rolls", jobs: [], plans: [], previews: {}, marks: {} }),
  nlePending: async () => ({ requests: fake.queue.splice(0) }),
  nleReply: async (r: { id: string }) => void fake.replies.push(r),
  listLuts: async () => [],
}));
vi.mock("@/lib/sync", async (orig) => ({
  ...(await orig<typeof import("@/lib/sync")>()),
  clientId: "tab-1",
  onTopic: (topic: string, fn: () => void) => (fake.topics.set(topic, fn), () => fake.topics.delete(topic)),
}));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), useMe: () => ({ username: "tiny" }), canChange: () => true }));
vi.mock("@/lib/library", () => ({ listLibraries: async () => [], listAssets: async () => ({ items: [] }) }));
vi.mock("@/components/AppBar", () => ({ AppBar: ({ trail, children }: { trail: string; children: unknown }) => <header>{trail}{children as never}</header> }));
const { NleDraftPage } = await import("./NleDraftPage");

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const deliver = async (a: Partial<NleAsk> & { id: string }) => {
  fake.queue.push({ edit: "e1", draft: "v1", kind: "run", ...a });
  act(() => fake.topics.get("nle:tab-1")!());
  await flush();
};

beforeEach(() => {
  fake.queue.length = 0;
  fake.replies.length = 0;
  fake.saved.length = 0;
  fake.draft = { timeline, notes: [], qa: { ok: true, notes: [], shared: [] }, filed: null, renders };
  window.history.pushState({}, "", "/editor/e1/v1");
  // the clips' files and thumbnails: none here
  vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
});

describe("the public timeline page on the editor", () => {
  it("opens the draft, runs the chat's commands there, refuses a version-2 edit, and Save sends the whole timeline with what it didn't know", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(<MemoryRouter initialEntries={["/editor/e1/v1"]}><NleDraftPage id="e1" name="v1" /></MemoryRouter>));
    await flush();
    await flush();
    expect(host.querySelector('[data-clip][aria-label^="V1"]')).toBeTruthy();
    await deliver({ id: "r1", commands: [{ id: "setLength", params: { seconds: 5 } }] });
    expect(fake.replies.at(-1)).toEqual({ id: "r1", result: expect.objectContaining({ length: 5 }) });
    await deliver({ id: "r2", commands: [{ id: "selectAll", params: {} }, { id: "key", params: { prop: "zoom" } }] });
    expect(fake.replies.at(-1)?.error).toContain("Not in this server's renders yet");
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", metaKey: true, bubbles: true })));
    await flush();
    expect(fake.saved).toHaveLength(1);
    const [id, name, tl] = fake.saved[0]!;
    expect([id, name]).toEqual(["e1", "v1"]);
    const back = fromNle(tl);
    expect(back.tracks.V1.items[0]).toMatchObject({ len: 125, line: "Roll forward", link: "l" });
    expect(back.tracks.A1.items[0]).toMatchObject({ len: 125 });
    act(() => root.unmount());
  });

  it("a planned edit opens on its render (Rendered), so its texts and effects show; an unsaved edit goes back to the timeline", async () => {
    fake.draft = { ...fake.draft, timeline: { ...timeline, plan: { kind: "talking head", texts: [{ text: "Tiny", from: 0, to: 2 } as never] } }, filed: { assetId: "rev-1", n: 3 } };
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(<MemoryRouter initialEntries={["/editor/e1/v1"]}><NleDraftPage id="e1" name="v1" /></MemoryRouter>));
    await flush();
    await flush();
    const rendered = () => host.querySelector<HTMLVideoElement>('video[aria-label="Rendered"]');
    const button = () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Viewer shows"] button')].find((b) => b.textContent === "rendered")!;
    expect(rendered()?.getAttribute("src")).toBe("/api/review/assets/rev-1/v/3/play");
    expect(button().getAttribute("aria-pressed")).toBe("true");
    await deliver({ id: "r3", commands: [{ id: "setLength", params: { seconds: 5 } }] });
    expect(rendered()).toBeNull();
    expect(button().disabled).toBe(true);
    act(() => root.unmount());
  });
});
