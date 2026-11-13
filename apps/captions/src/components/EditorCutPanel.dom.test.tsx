// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineView } from "@contracts/edit-timeline";
import { makeCut } from "@/lib/editor";
import { EditorCutPanel, type CutEdits } from "./EditorCutPanel";

// happy-dom has no audio decoder
vi.mock("@/lib/waveform", () => ({ peaks: vi.fn(async () => new Float32Array([0.5])) }));
vi.mock("@/lib/editor", () => ({ makeCut: vi.fn() }));

// The timeline's pointer work is not driven here: a stand-in has a button that makes the call a trim makes, and says
// what it was given (the rules, the steps of undo).
vi.mock("./EditTimeline", async () => {
  const real = await vi.importActual<typeof import("./EditTimeline")>("./EditTimeline");
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  return {
    ...real,
    EditTimeline: (p: { view: TimelineView; onEdit: (c: [unknown, object][]) => void; rules?: unknown; history?: { back: number }; edits?: unknown[] }) =>
      createElement("div", null,
        createElement("p", { "data-testid": "given" }, `rules:${p.rules === real.OWN_CUT_RULES} undo:${p.history?.back} edits:${p.edits?.length}`),
        createElement("button", { onClick: () => p.onEdit([[p.view.tracks[0].items[0], { tail: -12 }]]) }, "stub trim"),
        createElement("button", { onClick: () => p.onEdit([[p.view.tracks[0].items[0], { remove: true }]]) }, "stub take out")),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW: TimelineView = {
  name: "v1", fps: 30, duration: 90, width: 1080, height: 1920, markers: [],
  tracks: [
    { id: "V1", kind: "video", items: [{ key: "V1:0", track: "V1", rec: 0, len: 90, label: "Hook", kind: "clip" }] },
    { id: "V2", kind: "video", items: [{ key: "V2:20", track: "V2", rec: 20, len: 30, label: "Beach walk", kind: "clip" }] },
  ],
} as unknown as TimelineView;

let host: HTMLDivElement;
let root: Root;
const made = vi.fn();
const closed = vi.fn();
// it answers with something, as a Map's set does: the panel must not take that for an effect's clean-up
const keptNow = vi.fn((_: CutEdits) => new Map());
const settle = () => act(async () => { await new Promise((r) => setTimeout(r)); });
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name) as HTMLButtonElement | undefined;
const press = (name: string) => act(async () => { button(name)!.click(); await new Promise((r) => setTimeout(r)); });

async function open(opts: { timeline?: Response; working?: boolean; kept?: CutEdits } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/review/assets/ast/v/2/timeline") return opts.timeline ?? Response.json(VIEW);
    throw new Error(`Unexpected fetch: ${url}`);
  }));
  await act(async () => {
    root.render(<EditorCutPanel editId="e1" name="v1" title="Hook first" at={{ assetId: "ast", n: 2 }} working={!!opts.working} kept={opts.kept} onKeep={keptNow} onMade={made} onClose={closed} />);
  });
  await settle();
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("a version of the app's own AI Editor, opened to edit by hand on its edit's page", () => {
  it("shows the version's video and timeline with the rules of an own cut, and nothing to make yet", async () => {
    await open();
    expect(host.querySelector("video")?.getAttribute("src")).toBe("/api/review/assets/ast/v/2/play");
    expect(host.querySelector('[data-testid="given"]')?.textContent).toBe("rules:true undo:0 edits:0");
    expect(button("Make the next version")?.disabled).toBe(true);
  });

  it("makes the next version from the edits, on the version it is filed as, and starts clean", async () => {
    vi.mocked(makeCut).mockResolvedValue({ id: "e1" } as never);
    await open();
    await press("stub trim");
    expect(button("Make the next version")?.disabled).toBe(false);
    expect(host.textContent).toContain("The player shows this version as it is");
    await press("Make the next version");
    expect(makeCut).toHaveBeenCalledWith("e1", "v1", { asset: "ast", n: 2, edits: [expect.objectContaining({ key: "V1:0", tail: -12 })] });
    expect(made).toHaveBeenCalledWith({ id: "e1" });
    expect(host.querySelector('[data-testid="given"]')?.textContent).toBe("rules:true undo:0 edits:0");
  });

  it("says a refusal in the maker's own words and keeps the edits", async () => {
    vi.mocked(makeCut).mockRejectedValue(new Error("Hook: its footage has no more there"));
    await open();
    await press("stub trim");
    await press("Make the next version");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Hook: its footage has no more there");
    expect(made).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="given"]')?.textContent).toContain("edits:1");
  });

  it("⌘Z takes an edit back, but not while a field has the keys", async () => {
    await open();
    await press("stub trim");
    const field = document.createElement("input");
    document.body.append(field);
    await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true })); });
    expect(host.querySelector('[data-testid="given"]')?.textContent).toContain("edits:1");
    // a clip that was just clicked is a button with the focus: ⌘Z is still the panel's
    await act(async () => { button("stub trim")!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true })); });
    expect(host.querySelector('[data-testid="given"]')?.textContent).toContain("edits:0");
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true, bubbles: true })); });
    expect(host.querySelector('[data-testid="given"]')?.textContent).toContain("edits:1");
    field.remove();
  });

  it("hands every change of the edits to the page, and comes back with the ones it kept", async () => {
    await open();
    await press("stub trim");
    const kept = keptNow.mock.calls.at(-1)![0] as CutEdits;
    expect(kept.now).toEqual([expect.objectContaining({ key: "V1:0", tail: -12 })]);
    act(() => root.unmount());
    root = createRoot(host);
    await open({ kept });
    expect(host.querySelector('[data-testid="given"]')?.textContent).toBe("rules:true undo:1 edits:1");
    expect(button("Make the next version")?.disabled).toBe(false);
  });

  it("names the B-roll that sits on frames taken out: it goes with them", async () => {
    await open();
    await press("stub trim");
    expect(host.textContent).not.toContain("Beach walk");
    await press("stub take out");
    expect(host.textContent).toContain("On frames you took out, so it goes too: Beach walk.");
  });

  it("nothing is made while the version's steps run", async () => {
    await open({ working: true });
    await press("stub trim");
    expect(button("Make the next version")?.disabled).toBe(true);
  });

  it("a version filed without a timeline says so and offers nothing to make", async () => {
    await open({ timeline: new Response("no", { status: 404 }) });
    expect(host.textContent).toContain("filed before its timeline could be edited");
    expect(button("Make the next version")).toBeUndefined();
    await press("Close");
    expect(closed).toHaveBeenCalled();
  });
});
