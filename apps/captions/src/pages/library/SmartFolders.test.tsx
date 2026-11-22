// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Collection } from "@contracts/library";
import { suggestWays } from "./api";
import { AUTOMATIC, automaticAbout, ReorganizeDialog } from "./SmartFolders";

vi.mock("./api", () => ({ suggestWays: vi.fn(), setFolderRule: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ways = [
  { name: "By topic", folders: [{ name: "Garden Days", rule: "Days in the garden.", count: 11 }, { name: "Photos", rule: "Still photos.", count: 5 }] },
  { name: "By place", folders: [{ name: "Our House", rule: "Filmed at home.", count: 25 }] },
];
const folders = [{ id: "col_p", name: "Photos", parentId: null, kind: "manual", count: 5, createdBy: "admin" }] as Collection[];

let host: HTMLDivElement;
let root: Root;
const show = (open: boolean, libraryId = "lib_1") =>
  act(async () => root.render(<ReorganizeDialog libraryId={libraryId} open={open} folders={folders} onClose={() => {}} onDone={() => {}} />));
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  vi.mocked(suggestWays).mockReset().mockResolvedValue({ ways, about: false });
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("Reorganize", () => {
  it("a click outside keeps it open, and closing, reopening or leaving the page keeps the read: only Other ideas reads again", async () => {
    await show(true);
    await act(async () => button("Read the library")!.click());
    expect(document.body.textContent).toContain("Garden Days");
    await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(document.body.textContent).toContain("Garden Days");
    await show(false);
    await show(true);
    expect(document.body.textContent).toContain("Garden Days");
    await act(async () => root.unmount()); // the Library page left and opened again
    root = createRoot(host);
    await show(true);
    expect(document.body.textContent).toContain("Garden Days");
    expect(suggestWays).toHaveBeenCalledTimes(1);
    await act(async () => button("Other ideas")!.click());
    expect(suggestWays).toHaveBeenCalledTimes(2);
  });

  it("a read still running when the page is left is picked up, not asked again", async () => {
    let answer!: (r: { ways: typeof ways; about: boolean }) => void;
    vi.mocked(suggestWays).mockReturnValue(new Promise((r) => (answer = r)));
    await show(true, "lib_2");
    await act(async () => button("Read the library")!.click());
    await act(async () => root.unmount());
    root = createRoot(host);
    await show(true, "lib_2");
    expect(document.body.textContent).toContain("Reading the library");
    await act(async () => answer({ ways, about: false }));
    expect(document.body.textContent).toContain("Our House");
    expect(suggestWays).toHaveBeenCalledTimes(1);
  });

  it("each folder is one line with its count; its rule opens on a tap; a folder already there says exists", async () => {
    await show(true, "lib_3");
    await act(async () => button("Read the library")!.click());
    expect(document.body.textContent).not.toContain("Days in the garden.");
    const garden = [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Garden Days"))!;
    expect(garden.textContent).toBe("Garden Days11");
    await act(async () => garden.click());
    expect(document.body.textContent).toContain("Days in the garden.");
    expect([...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Photos"))!.textContent).toBe("Photosexists5");
  });
});

describe("automaticAbout", () => {
  it("finds an automatic folder's line whatever order the server keeps its query's keys in", () => {
    for (const a of AUTOMATIC.filter((x) => x.query)) {
      const reversed = Object.fromEntries(Object.entries(a.query!).reverse());
      expect(automaticAbout({ id: "c", name: "x", parentId: null, kind: "smart", createdBy: "admin", query: reversed } as Collection)).toBe(a.about);
    }
    expect(automaticAbout({ id: "c", name: "x", parentId: null, kind: "manual", createdBy: "admin", rule: "Beach days" } as Collection)).toBe("Beach days");
  });
});
