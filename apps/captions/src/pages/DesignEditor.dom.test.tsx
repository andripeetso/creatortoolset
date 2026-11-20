// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Design } from "@contracts/design";
import { useAuth } from "@/lib/auth";

// The designer opened over another page (the video editor) on one design: Done saves the change not sent yet, then
// hands back. The canvas itself is left out (no 2D canvas here): the change is made in the properties panel.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const design: Design = { id: "d1", owner: "owner", name: "Title", kind: "thumbnail", format: "thumbnail", width: 1920, height: 1080, pictures: [], createdAt: 1, updatedAt: 1, pages: [{ id: "p1", x: 0, y: 0, w: 1920, h: 1080, background: "#ffffff", layers: [] }] };
const saveDesign = vi.fn(async (_id: string, body: { pages?: Design["pages"] }) => ({ ...design, pages: body.pages ?? design.pages, updatedAt: 2 }));
vi.mock("@/lib/designs", async (real) => ({ ...(await real<typeof import("@/lib/designs")>()), getDesign: vi.fn(async () => design), saveDesign: (id: string, body: { pages?: Design["pages"] }) => saveDesign(id, body) }));
vi.mock("@/components/design/Stage", () => ({ Stage: () => null }));
vi.mock("@/components/AppBar", () => ({ AppBar: ({ children }: { children?: React.ReactNode }) => <header>{children}</header> }));
// the same list each time: a new one is a change the page draws again for
const noFonts = vi.hoisted(() => [] as never[]);
vi.mock("@/lib/design/own-fonts", async (real) => ({ ...(await real<typeof import("@/lib/design/own-fonts")>()), useOwnFonts: () => noFonts }));
vi.mock("@/lib/local-cache", () => ({ useCachedLoad: () => ({ data: null, refresh: async () => {} }) }));
vi.mock("@/lib/sync", async (real) => ({ ...(await real<typeof import("@/lib/sync")>()), onTopic: () => () => {} }));
const { DesignEditor } = await import("./DesignPage");

let root: Root | undefined;
let host: HTMLDivElement | undefined;
beforeEach(() => {
  useAuth.setState({ required: false, me: { username: "owner", role: "admin", cloud: false, off: [] } });
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: async () => [] } });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = undefined;
  saveDesign.mockClear();
});

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const button = (name: string) => [...document.querySelectorAll<HTMLElement>("button,[role=checkbox]")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);

it("opens the one design full screen, and Done saves what was not saved yet before it hands back", async () => {
  const onDone = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter><DesignEditor id="d1" onDone={onDone} /></MemoryRouter>));
  await settle();
  expect(document.querySelector('[role="dialog"][aria-label="Design"]')).toBeTruthy();
  // the assistant beside the page is told which design is open
  expect(document.body.textContent).toContain("design id d1");
  // a change: the frame made see-through (saved 700 ms later on its own; Done does not wait for that)
  const transparent = [...document.querySelectorAll("label")].find((l) => l.textContent?.includes("Transparent background"))!.querySelector<HTMLElement>("[role=checkbox]")!;
  act(() => transparent.click());
  await settle();
  expect(saveDesign).not.toHaveBeenCalled();
  await act(async () => button("Done")!.click());
  await settle();
  expect(saveDesign).toHaveBeenCalledTimes(1);
  expect(saveDesign.mock.calls[0]![1].pages![0]!.fills).toEqual([]);
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(saveDesign.mock.invocationCallOrder[0]!).toBeLessThan(onDone.mock.invocationCallOrder[0]!);
});

it("stays open when the save fails, and says why", async () => {
  saveDesign.mockRejectedValueOnce(new Error("The server is not reachable"));
  const onDone = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter><DesignEditor id="d1" onDone={onDone} /></MemoryRouter>));
  await settle();
  const transparent = [...document.querySelectorAll("label")].find((l) => l.textContent?.includes("Transparent background"))!.querySelector<HTMLElement>("[role=checkbox]")!;
  act(() => transparent.click());
  await settle();
  await act(async () => button("Done")!.click());
  await settle();
  expect(onDone).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("The server is not reachable");
});

it("a save refused because the design changed elsewhere is merged and sent again before it hands back", async () => {
  const { DesignChanged } = await import("@/lib/designs");
  const elsewhere: Design = { ...design, updatedAt: 5, pages: [{ ...design.pages[0]!, name: "Renamed elsewhere" }] };
  saveDesign.mockRejectedValueOnce(new DesignChanged(elsewhere));
  const onDone = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter><DesignEditor id="d1" onDone={onDone} /></MemoryRouter>));
  await settle();
  const transparent = [...document.querySelectorAll("label")].find((l) => l.textContent?.includes("Transparent background"))!.querySelector<HTMLElement>("[role=checkbox]")!;
  act(() => transparent.click());
  await settle();
  await act(async () => button("Done")!.click());
  await settle();
  expect(saveDesign).toHaveBeenCalledTimes(2);
  // both changes in the save that went through: theirs and this window's
  const last = saveDesign.mock.calls[1]![1].pages![0]!;
  expect([last.name, last.fills]).toEqual(["Renamed elsewhere", []]);
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(saveDesign.mock.invocationCallOrder[1]!).toBeLessThan(onDone.mock.invocationCallOrder[0]!);
});
