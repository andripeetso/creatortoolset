// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowseBar } from "./Bar";
import { FolderCard, FolderRow, type FolderDrop } from "./Folder";
import { BrowseList, ListRow, type ListSection } from "./List";
import { folderOptions, folderPath, shownItems } from "./browse";

// The two browse views every tool shares: the folder's drops and menu, the list's folds, the bar's controls, and the
// folder tree helpers a library with folders inside folders uses.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = undefined;
});
function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter>{node}</MemoryRouter>));
  return host;
}

/** A drag event carrying `data` (type → value) and `files`, as the browser hands it to a drop target. */
function dragEvent(type: string, data: Record<string, string>, files: File[] = []) {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
  e.dataTransfer = {
    types: [...Object.keys(data), ...(files.length ? ["Files"] : [])],
    getData: (t: string) => data[t] ?? "",
    files,
  };
  return e;
}

const ITEM = "application/x-test-item";
const drop = (over: Partial<FolderDrop> = {}): FolderDrop => ({ type: ITEM, onItems: vi.fn(), onFiles: vi.fn(), label: "Move into this folder", ...over });

describe("FolderCard", () => {
  it("shows up to four pictures from inside it, its name and its count, and opens on click", () => {
    const el = render(
      <FolderCard name="Rolling practice" to="/review?p=1" meta="4 videos" covers={["a", "b", "c", "d", "e"].map((s) => ({ src: `/t/${s}`, hidden: s === "b" }))} />,
    );
    const imgs = [...el.querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["/t/a", "/t/b", "/t/c", "/t/d"]);
    expect(imgs[1].style.opacity).toBe("0"); // not revealed yet, its place kept
    expect(el.querySelector("a")!.getAttribute("href")).toBe("/review?p=1");
    expect(el.textContent).toContain("Rolling practice");
    expect(el.textContent).toContain("4 videos");
  });

  it("an empty folder shows the folder sign, not a picture", () => {
    const el = render(<FolderCard name="Empty" to="/x" covers={[]} />);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("svg")).not.toBeNull();
  });

  it("items dropped on it go in, several at once; files dropped on it are uploaded into it", () => {
    const d = drop();
    const el = render(<FolderCard name="F" to="/f" covers={[]} drop={d} />);
    const card = el.querySelector("a")!;
    const over = dragEvent("dragover", { [ITEM]: "1,2,3" });
    act(() => void card.dispatchEvent(over));
    expect(over.defaultPrevented).toBe(true);
    expect(el.textContent).toContain("Move into this folder");
    act(() => void card.dispatchEvent(dragEvent("drop", { [ITEM]: "1,2,3" })));
    expect(d.onItems).toHaveBeenCalledWith(["1", "2", "3"]);
    const file = new File(["x"], "clip.mp4", { type: "video/mp4" });
    act(() => void card.dispatchEvent(dragEvent("drop", {}, [file])));
    expect(d.onFiles).toHaveBeenCalledWith([file]);
  });

  it("takes nothing while dropping is off, and nothing it does not know", () => {
    const off = render(<FolderCard name="F" to="/f" covers={[]} drop={drop({ enabled: false })} />).querySelector("a")!;
    const e = dragEvent("dragover", { [ITEM]: "1" });
    off.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    act(() => root!.unmount());
    root = undefined;
    const noFiles = render(<FolderCard name="F" to="/f" covers={[]} drop={drop({ onFiles: undefined })} />).querySelector("a")!;
    const files = dragEvent("dragover", {}, [new File(["x"], "a.mp4")]);
    noFiles.dispatchEvent(files);
    expect(files.defaultPrevented).toBe(false); // the page's own drop takes them
  });

  it("right-click: Open, Rename…, the tool's items, then Delete with its words", async () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    const el = render(<FolderCard name="F" to="/f" covers={[]} onRename={onRename} onDelete={onDelete} deleteLabel="Delete project" menu={<span>Mark finished</span>} />);
    await act(async () => void el.querySelector("a")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim());
    expect(items).toEqual(["Open", "Rename…", "Delete project"]);
    expect(document.body.textContent).toContain("Mark finished");
    act(() => (document.querySelectorAll('[role="menuitem"]')[1] as HTMLElement).click());
    expect(onRename).toHaveBeenCalled();
  });
});

describe("FolderRow", () => {
  it("is the same folder as a row: name, count, link and drops", () => {
    const d = drop();
    const el = render(<FolderRow name="Bath time" to="/f/2" meta={2} drop={d} />);
    const row = el.querySelector("a")!;
    expect(row.getAttribute("href")).toBe("/f/2");
    expect(row.textContent).toContain("Bath time");
    act(() => void row.dispatchEvent(dragEvent("drop", { [ITEM]: "9" })));
    expect(d.onItems).toHaveBeenCalledWith(["9"]);
  });
});

describe("BrowseList", () => {
  const sections = (open: boolean, toggle = () => {}): ListSection<string>[] => [
    { key: "pinned", label: "Pinned", items: ["p"] },
    { key: "main", items: ["a", "b"] },
    { key: "done", label: "Published", items: ["x", "y"], fold: { open, onToggle: toggle } },
    { key: "none", label: "Shelved", items: [], fold: { open: true, onToggle: () => {} } },
  ];
  const row = (s: string) => <div key={s} data-row={s} />;

  it("rows under their headings; a folded section shows its heading and count only; an empty one nothing", () => {
    const el = render(<BrowseList sections={sections(false)} row={row} />);
    expect([...el.querySelectorAll("[data-row]")].map((r) => r.getAttribute("data-row"))).toEqual(["p", "a", "b"]);
    expect(el.textContent).toContain("Pinned (1)");
    expect(el.textContent).toContain("Published (2)");
    expect(el.textContent).not.toContain("Shelved");
  });

  it("its heading opens it", () => {
    const toggle = vi.fn();
    const el = render(<BrowseList sections={sections(false, toggle)} row={row} />);
    const head = el.querySelector("button[aria-expanded]")!;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    act(() => (head as HTMLElement).click());
    expect(toggle).toHaveBeenCalled();
  });

  it("the rows on screen, in order, for a Shift-click run", () => {
    expect(shownItems(sections(false))).toEqual(["p", "a", "b"]);
    expect(shownItems(sections(true))).toEqual(["p", "a", "b", "x", "y"]);
  });

  it("a row picks on a Shift or ⌘ click, not a plain one or a click on its buttons, and opens its menu on right-click", () => {
    const onPick = vi.fn();
    const onMenu = vi.fn();
    const el = render(
      <ListRow onPick={onPick} onMenu={onMenu}>
        <span data-t="name">Name</span>
        <button type="button">Share</button>
      </ListRow>,
    );
    const name = el.querySelector('[data-t="name"]')!;
    act(() => void name.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onPick).not.toHaveBeenCalled();
    act(() => void el.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(onPick).not.toHaveBeenCalled();
    act(() => void name.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })));
    expect(onPick).toHaveBeenCalledTimes(1);
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => void name.dispatchEvent(menu));
    expect(onMenu).toHaveBeenCalled();
    expect(menu.defaultPrevented).toBe(true);
  });
});

describe("BrowseBar", () => {
  it("chips with their counts, the sort, and ⌘K to the search", () => {
    const onChip = vi.fn();
    const onSort = vi.fn();
    const el = render(
      <BrowseBar
        search={{ value: "", onChange: () => {}, placeholder: "Search sessions (⌘K)" }}
        chips={{ value: "all", onChange: onChip, options: [{ id: "all", label: "All", count: 3 }, { id: "reel", label: "Reel", count: 2, dot: "bg-pink-500" }] }}
        sort={{ value: "status", onChange: onSort, label: "Sort sessions", options: [{ id: "recent", label: "Recent" }, { id: "status", label: "Status" }] }}
      >
        <button type="button">New session</button>
      </BrowseBar>,
    );
    const chips = [...el.querySelectorAll("button[aria-pressed]")];
    expect(chips.map((c) => [c.textContent, c.getAttribute("aria-pressed")])).toEqual([["All · 3", "true"], ["Reel · 2", "false"]]);
    act(() => (chips[1] as HTMLElement).click());
    expect(onChip).toHaveBeenCalledWith("reel");
    const select = el.querySelector("select")!;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Sort: Recent", "Sort: Status"]);
    expect(select.value).toBe("status");
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })));
    expect(document.activeElement).toBe(el.querySelector("input"));
    expect(el.textContent).toContain("New session");
  });
});

describe("folder tree", () => {
  const folders = [
    { id: "a", name: "Shoots", parentId: null },
    { id: "b", name: "2026", parentId: "a" },
    { id: "c", name: "March", parentId: "b" },
    { id: "d", name: "Finals" },
    { id: "e", name: "Lost", parentId: "gone" },
  ];

  it("the trail from the top down to a folder", () => {
    expect(folderPath(folders, "c").map((f) => f.name)).toEqual(["Shoots", "2026", "March"]);
    expect(folderPath(folders, null)).toEqual([]);
    expect(folderPath(folders, "nope")).toEqual([]);
  });

  it("Move to: each folder under its parent, and never a folder into itself or below itself", () => {
    expect(folderOptions(folders).map((f) => `${f.depth}${f.name}`)).toEqual(["0Shoots", "12026", "2March", "0Finals", "0Lost"]);
    expect(folderOptions(folders, "b").map((f) => f.name)).toEqual(["Shoots", "Finals", "Lost"]);
  });
});
