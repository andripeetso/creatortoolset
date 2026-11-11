// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Media Library page in a DOM, with a test plug-in that adds facets to it: the page reads them from webPlugins
// (library-slots.ts), so the plug-in's facet groups must show once the library has loaded. Also: an empty library is one
// screen, Finals is never shown here, A-roll / B-roll narrow the grid, a clip being prepared says so. The server calls
// are stubbed.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../plugins.gen", () => ({
  webPlugins: [
    {
      id: "tiny",
      library: {
        facets: [
          { key: "tiny", label: "Tiny Facet", values: [{ value: "on", label: "Tiny on" }], scope: "both" },
          { key: "libonly", label: "Library Only Facet", values: [{ value: "x", label: "Library x" }], scope: "library" },
          { key: "finalsonly", label: "Finals Only Facet", values: [{ value: "f", label: "Finals f" }], scope: "finals" },
        ],
      },
    },
  ],
}));

type Card = { id: string; title: string; kind: string; state: string; thumbUrl?: string; roll?: "a" | "b"; tags: string[]; aiTags: string[] };
const clip = (id: string, more: Partial<Card> = {}): Card => ({ id, title: `Tiny Acrobatics ${id}`, kind: "video", state: "ready", tags: [], aiTags: [], ...more });
const server = vi.hoisted(() => ({
  items: [] as unknown[],
  trash: [] as unknown[],
  folders: [] as unknown[],
  watch: { allowed: true, folders: [] as unknown[], missing: 0 } as unknown,
  /** what the page asked the listing for, and the folder changes it sent */
  asked: [] as Record<string, unknown>[],
  changed: [] as unknown[][],
}));

vi.mock("@/lib/library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/library")>()),
  listLibraries: async () => [{ id: "lib_tiny", name: "Tiny", storage: "local", settings: { describe: true, embed: false } }],
  // the stand-in narrows by roll the way the server does (api/library/query.ts): the page asks, it does not filter
  listAssets: async (_: string, q: { trashed?: boolean; roll?: "a" | "b" }) => {
    server.asked.push(q);
    return { items: (q.trashed ? server.trash : server.items).filter((x) => !q.roll || (x as { roll?: string }).roll === q.roll), next: null };
  },
  changeFolderItems: async (...a: unknown[]) => {
    server.changed.push(a);
    return { added: 1 };
  },
  listCollections: async () => server.folders,
  listSources: async () => [],
  getWatch: async () => server.watch,
  getProgress: async () => ({ done: 0, left: 0, clips: 0, seconds: 0, waiting: [] }),
  getLibraryStorage: async () => ({ kind: "local", keysSet: false, serverBucket: false, locked: true, days: [] }),
  getEstimate: async () => ({ clips: 1, minutes: 0, seconds: 0, steps: [{ step: "describe", route: "provider", usd: 0, seconds: 1, measured: false }] }),
}));

const { default: LibraryPage } = await import("./LibraryPage");

let root: Root | null = null;
beforeEach(() => {
  server.items = [clip("one")];
  server.trash = [];
  server.folders = [];
  server.watch = { allowed: true, folders: [], missing: 0 };
  server.asked = [];
  server.changed = [];
});
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  root = null;
});

/** Renders the page and waits for its first effects (the library load) to settle. */
async function mount(at = "/library"): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[at]}>
        <LibraryPage />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return host;
}

describe("Media Library page with a plug-in facet", () => {
  it("draws the plug-in facet groups it is scoped to, and not the Finals-only one", async () => {
    const host = await mount();
    expect(host.querySelector('[role="group"][aria-label="Tiny Facet"]')).not.toBeNull();
    expect(host.querySelector('[role="group"][aria-label="Library Only Facet"]')).not.toBeNull();
    expect(host.querySelector('[role="group"][aria-label="Finals Only Facet"]')).toBeNull();
    expect(host.textContent).toContain("Tiny on");
  });

  it("a picked plug-in value toggles on its button", async () => {
    const host = await mount();
    const on = [...host.querySelectorAll("button")].find((b) => b.textContent === "Tiny on")!;
    expect(on.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      on.click();
    });
    expect(on.getAttribute("aria-pressed")).toBe("true");
  });
});

const buttons = (host: HTMLElement) => [...host.querySelectorAll("button")].map((b) => b.textContent?.trim());

describe("Media Library page", () => {
  it("an empty library is one screen: what it is for and the folder to choose, upload as the second way, nothing else", async () => {
    server.items = [];
    const host = await mount();
    expect(host.textContent).toContain("Where are your videos?");
    expect(host.textContent).toContain("raw materials");
    expect(buttons(host)).toEqual(expect.arrayContaining(["Choose a folder", "Upload files"]));
    expect(buttons(host)).not.toContain("Skip");
    expect(host.querySelector('[role="searchbox"]')).toBeNull();
    expect(host.querySelector('[aria-label="Kind"]')).toBeNull();
    expect(host.querySelector('[aria-label^="Library settings"]')).toBeNull();
    expect(host.querySelector('input[type="checkbox"], [role="switch"]')).toBeNull();
    expect(host.querySelector('input[type="file"]')).not.toBeNull(); // Upload files still has its picker
  });

  it("a library whose only clips are in the trash is not the first screen: the Trash stays reachable", async () => {
    server.items = [];
    server.trash = [clip("gone")];
    const host = await mount();
    expect(host.textContent).not.toContain("Where are your videos?");
    expect(host.querySelector('[role="searchbox"]')).not.toBeNull();
  });

  it("a footage folder with no clips yet says so, not the first screen", async () => {
    server.items = [];
    server.watch = { allowed: true, folders: [{ path: "/Users/tiny/Movies/Trip", mode: "reference", addedBy: "admin", found: true, imported: 0, files: 0, adding: 0 }], missing: 0 };
    const host = await mount();
    expect(host.textContent).toContain("No videos in your folder yet.");
  });

  it("shows no Finals: not the folder the Finals tool reads, not a way to make one", async () => {
    server.folders = [
      { id: "col_f", name: "Finals", parentId: null, kind: "manual", count: 3, createdBy: "admin" },
      { id: "col_t", name: "Trip", parentId: null, kind: "manual", count: 1, createdBy: "admin" },
    ];
    const host = await mount();
    expect(host.textContent).not.toContain("Finals");
    expect(host.querySelector('[aria-label^="Library settings"]')).not.toBeNull(); // the owner's one settings button
  });

  it("the settings button says so when a footage folder is not found (its drive unplugged)", async () => {
    server.watch = { allowed: true, folders: [{ path: "/Volumes/Card/Trip", mode: "reference", addedBy: "admin", found: false, imported: 3, files: 0, adding: 0 }], missing: 3 };
    const host = await mount();
    expect(host.querySelector('[aria-label^="Library settings"]')?.getAttribute("aria-label")).toContain("not found");
  });

  it("Library settings holds the footage folders, storage and the AI switches; a hosted server has no footage folders", async () => {
    const host = await mount();
    const open = async () => {
      await act(async () => (host.querySelector('[aria-label^="Library settings"]') as HTMLButtonElement).click());
      await act(async () => new Promise((r) => setTimeout(r, 0)));
    };
    await open();
    const sheet = () => document.querySelector('[role="dialog"]')?.textContent ?? "";
    expect(sheet()).toContain("Footage folders");
    expect(sheet()).toContain("Storage");
    expect(sheet()).toContain("Search by meaning");
    expect(sheet()).toContain("Runs on your connected AI");
    expect(sheet()).not.toContain("OpenAI key");
    act(() => root?.unmount());
    document.body.innerHTML = "";
    server.watch = { allowed: false, folders: [], missing: 0 };
    const hosted = await mount();
    await act(async () => (hosted.querySelector('[aria-label^="Library settings"]') as HTMLButtonElement).click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(sheet()).toContain("Storage");
    expect(sheet()).not.toContain("Footage folders");
  });

  it("A-roll and B-roll ask the server for that roll, so the whole library is narrowed", async () => {
    server.items = [clip("talk", { roll: "a" }), clip("cover", { roll: "b" })];
    const host = await mount();
    const b = [...host.querySelectorAll('[aria-label="Roll"] button')].find((x) => x.textContent === "B-roll") as HTMLButtonElement;
    await act(async () => b.click());
    expect(host.textContent).toContain("Tiny Acrobatics cover");
    expect(host.textContent).not.toContain("Tiny Acrobatics talk");
  });

  it("offers no roll row when no clip has been sorted", async () => {
    const host = await mount();
    expect(host.querySelector('[aria-label="Roll"]')).toBeNull();
  });

  it("a clip being prepared says so until its picture comes, with no amber", async () => {
    server.items = [clip("new", { state: "processing" }), clip("half", { state: "processing", thumbUrl: "/thumb.jpg" })];
    const host = await mount();
    const [fresh, pictured] = [...host.querySelectorAll('button[data-state="processing"]')];
    expect(fresh.textContent).toContain("Preparing");
    expect(pictured.querySelector("img")).not.toBeNull();
    expect(pictured.textContent).not.toContain("Preparing");
    expect(host.innerHTML).not.toMatch(/amber/);
  });

  it("a failed clip says why and a missing one says so", async () => {
    server.items = [clip("bad", { state: "failed" }), clip("away", { state: "missing" })];
    const host = await mount();
    expect(host.textContent).toContain("Couldn't read this file");
    expect(host.textContent).toContain("File not found");
  });
});

describe("Media Library folders", () => {
  const folders = [
    { id: "col_t", name: "Trip", parentId: null, kind: "manual", count: 1, covers: ["/api/library/media/v1/thumb"], createdBy: "admin" },
    { id: "col_b", name: "Beach", parentId: "col_t", kind: "manual", count: 0, createdBy: "admin" },
    { id: "col_s", name: "Apples", parentId: null, kind: "smart", query: { q: "apples" }, createdBy: "admin" },
  ];
  const link = (host: HTMLElement, name: string) => [...host.querySelectorAll("a")].find((a) => a.textContent?.includes(name));
  /** a page item dropped on an element, as the browser hands it over */
  const drop = (el: Element, id: string) => {
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types: ["application/x-ct-media-item"], getData: (t: string) => (t === "application/x-ct-media-item" ? id : ""), files: [] } });
    el.dispatchEvent(e);
  };

  it("the top level shows its folders (saved searches last) and asks only for the clips in no folder", async () => {
    server.folders = folders;
    const host = await mount();
    expect(link(host, "Trip")?.getAttribute("href")).toBe("/library?f=col_t");
    expect(link(host, "Trip")?.querySelector("img")?.getAttribute("src")).toBe("/api/library/media/v1/thumb");
    expect(link(host, "Beach")).toBeUndefined();
    const names = [...host.querySelectorAll('a[href^="/library?f="]')].map((a) => a.textContent);
    expect(names.findIndex((n) => n?.includes("Apples"))).toBeGreaterThan(names.findIndex((n) => n?.includes("Trip")));
    expect(server.asked.at(-1)).toMatchObject({ unfiled: true });
    expect(host.querySelector('a[aria-label="Trash"]')?.getAttribute("href")).toBe("/library?trash=1");
    expect(buttons(host)).toContain("New folder");
  });

  it("a folder opens from the address with the trail back up and its own folders; a clip dropped on one moves there", async () => {
    server.folders = folders;
    const host = await mount("/library?f=col_t");
    expect(host.querySelector('nav[aria-label="Folder"]')?.textContent).toBe("TinyTrip");
    expect(link(host, "Beach")).toBeDefined();
    expect(link(host, "Apples")).toBeUndefined();
    expect(server.asked.at(-1)).toMatchObject({ collectionId: "col_t" });
    await act(async () => drop(link(host, "Beach")!, "one"));
    expect(server.changed).toEqual([
      ["lib_tiny", "col_b", ["one"], true],
      ["lib_tiny", "col_t", ["one"], false],
    ]);
  });

  it("a saved search takes no drops and has no New folder inside it", async () => {
    server.folders = folders;
    const top = await mount();
    await act(async () => drop(link(top, "Apples")!, "one"));
    expect(server.changed).toEqual([]);
    act(() => root?.unmount());
    document.body.innerHTML = "";
    const inside = await mount("/library?f=col_s");
    expect(inside.querySelector('nav[aria-label="Folder"]')?.textContent).toBe("TinyApples");
    expect(buttons(inside)).not.toContain("New folder");
  });

  it("the Trash opens from the address, under its own trail, with no folders", async () => {
    server.folders = folders;
    server.trash = [clip("gone")];
    const host = await mount("/library?trash=1");
    expect(host.querySelector('nav[aria-label="Folder"]')?.textContent).toBe("TinyTrash");
    expect(link(host, "Trip")).toBeUndefined();
    expect(host.textContent).toContain("Tiny Acrobatics gone");
    expect(server.asked.at(-1)).toMatchObject({ trashed: true });
  });
});
