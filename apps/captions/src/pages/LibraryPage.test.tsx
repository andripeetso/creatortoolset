// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Media Library page in a DOM, with a test plug-in that adds facets to it: the page reads them from webPlugins
// (library-slots.ts), so the plug-in's facet groups must show once the library has loaded. Also: an empty library is its
// own page with the first-run question, Finals is never shown here, A-roll / B-roll narrow the grid, a clip being prepared says so. The server calls
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
  /** the plug-in sources this library offers (its Source picker) */
  sources: [] as { id: string; label: string }[],
  watch: { allowed: true, folders: [] as unknown[], missing: 0 } as unknown,
  /** what the page asked the listing for, and the folder changes it sent */
  asked: [] as Record<string, unknown>[],
  changed: [] as unknown[][],
  searched: [] as string[],
  /** clips in a folder: the top level's listing (unfiled) leaves them out */
  filed: new Set<string>(),
  /** the library's settings as the server has them, and the changes the page sent */
  settings: {} as Record<string, unknown>,
  patched: [] as unknown[],
  /** saves and uploads, in the order they were sent */
  sent: [] as string[],
  trashed: [] as string[],
  uploaded: [] as string[],
  /** the library is someone else's, given to look at */
  readOnly: false,
  gate: undefined as Promise<void> | undefined,
  /** a test holds every upload until it lets go */
  uploading: undefined as Promise<void> | undefined,
}));

vi.mock("@/lib/library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/library")>()),
  listLibraries: async () => [
    { id: "lib_tiny", name: "Tiny", storage: "local", settings: { describe: true, embed: false, setupAt: "2026-11-01T00:00:00.000Z", ...server.settings }, ...(server.readOnly ? { readOnly: true } : {}) },
  ],
  // Default folders makes the six folders (api/library/organize.ts)
  uploadFile: async (_: string, f: File) => {
    server.sent.push(`upload ${f.name}`);
    server.uploaded.push(f.name);
    await server.uploading;
    return { assetId: "new" };
  },
  updateLibrary: async (_: string, patch: { settings: Record<string, unknown> }) => {
    server.patched.push(patch);
    server.sent.push("save");
    Object.assign(server.settings, patch.settings);
    if (patch.settings.organize === "default" || patch.settings.organize === "ai")
      server.folders = ["A-roll", "B-roll", "Music", "Sound effects", "Graphics", "Examples"].map((name, i) => ({
        id: `col_${i}`,
        name,
        parentId: null,
        kind: i < 2 ? "smart" : "manual",
        count: 0,
        createdBy: "admin",
      }));
    return { id: "lib_tiny", name: "Tiny", storage: "local", settings: { describe: true, embed: false, setupAt: "2026-11-01T00:00:00.000Z", ...server.settings } };
  },
  // the stand-in narrows by roll the way the server does (api/library/query.ts): the page asks, it does not filter
  listAssets: async (_: string, q: { trashed?: boolean; roll?: "a" | "b"; unfiled?: boolean }) => {
    server.asked.push(q);
    const items = (q.trashed ? server.trash : server.items) as Card[];
    return { items: items.filter((x) => (!q.roll || x.roll === q.roll) && !(q.unfiled && server.filed.has(x.id))), next: null };
  },
  searchLibrary: async (_: string, q: string) => {
    server.searched.push(q);
    return { hits: server.items.map((asset) => ({ asset })), meaningGettingReady: false };
  },
  changeFolderItems: async (...a: unknown[]) => {
    server.changed.push(a);
    await server.gate; // a test holds the answer to see the page before it
    return { added: 1 };
  },
  listCollections: async () => server.folders,
  listSources: async () => server.sources,
  getWatch: async () => server.watch,
  getProgress: async () => ({ done: 0, left: 0, clips: 0, seconds: 0, waiting: [] }),
  getLibraryStorage: async () => ({ kind: "local", keysSet: false, serverBucket: false, locked: true, days: [] }),
  listTags: async () => [{ tag: "beach", count: 2 }],
  listPlaces: async () => [],
  deleteCollection: async (_: string, id: string) => {
    server.changed.push(["delete", id]);
    return { ok: true };
  },
  setTrashed: async (_: string, id: string) => {
    server.trashed.push(id);
    server.items = (server.items as Card[]).filter((x) => x.id !== id);
  },
  getAsset: async (_: string, id: string) => ({ jobs: [], ...(server.items as Card[]).find((x) => x.id === id) }),
  checkUpload: async () => ({ maybe: false }),
  getEstimate: async () => ({ clips: 1, minutes: 0, seconds: 0, steps: [{ step: "describe", route: "provider", usd: 0, seconds: 1, measured: false }] }),
}));

vi.mock("./library/api", () => ({
  tabCounts: async () => {
    const items = server.items as Card[];
    return { a: items.filter((x) => x.roll === "a").length, b: items.filter((x) => x.roll === "b").length, image: items.filter((x) => x.kind === "image").length };
  },
  restoreFolder: async (_: string, id: string) => {
    server.changed.push(["restore", id]);
    return { id };
  },
}));

const { default: LibraryPage } = await import("./LibraryPage");
const { undoLatest } = await import("@/lib/undo");

let root: Root | null = null;
beforeEach(() => {
  server.items = [clip("one")];
  server.trash = [];
  server.folders = [];
  server.sources = [];
  server.watch = { allowed: true, folders: [], missing: 0 };
  server.settings = {};
  server.patched = [];
  server.sent = [];
  server.asked = [];
  server.changed = [];
  server.searched = [];
  server.filed = new Set();
  server.trashed = [];
  server.uploaded = [];
  server.readOnly = false;
  server.gate = undefined;
  server.uploading = undefined;
  localStorage.clear();
});
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  root = null;
});

/** The address the page is at, for the tests to read. */
function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.search}</output>;
}
const where = () => document.querySelector('[data-testid="where"]')?.textContent ?? "";
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** Renders the page and waits for its first effects (the library load) to settle. */
async function mount(at = "/library"): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[at]}>
        <LibraryPage />
        <Where />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return host;
}

describe("Media Library page with a plug-in facet", () => {
  beforeEach(() => {
    server.sources = [{ id: "tiny-footage", label: "Tiny footage" }];
  });

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

  it("draws none where the plug-in's source is not offered (another workspace's own library)", async () => {
    server.sources = [];
    const host = await mount();
    expect(host.querySelector('[role="group"][aria-label="Tiny Facet"]')).toBeNull();
  });
});

const buttons = (host: HTMLElement) => [...host.querySelectorAll("button")].map((b) => b.textContent?.trim());
// the row's More (…) menu: Library settings and the Trash
const more = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label^="More"]');
const openMore = async (host: HTMLElement) => {
  await act(async () => more(host)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })));
};
const moreItem = (text: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((x) => x.textContent?.includes(text));

describe("Media Library page", () => {
  it("an empty library is its own page: it says what it is for, the folder to choose, upload as the second way", async () => {
    server.items = [];
    const host = await mount();
    expect(host.querySelector('[role="searchbox"]')).not.toBeNull(); // the library's own layout, not a card in its place
    expect(more(host)).not.toBeNull(); // Library settings, in the More menu
    expect(host.textContent).not.toContain("Where are your videos?");
    expect(host.textContent).toContain("No clips");
    expect(buttons(host)).toEqual(expect.arrayContaining(["Set up", "Upload files", "Upload"])); // setup owns the folders now
    expect(buttons(host)).not.toContain("Choose a folder");
    expect(host.textContent).not.toContain("Copies");
    expect(buttons(host)).not.toContain("Skip");
    expect(host.querySelector('input[type="file"]')).not.toBeNull(); // Upload files still has its picker
  });

  it("an owner whose library was never set up is asked to set it up; a set-up library is not", async () => {
    server.settings = { setupAt: undefined }; // the fixture's library has no setupAt
    await mount();
    expect(document.body.textContent).toContain("Let's set up the Media Library");
    await act(async () => root!.unmount());
    root = null;
    server.settings = {};
    await mount();
    expect(document.body.textContent).not.toContain("Let's set up the Media Library");
  });

  it("the first upload asks how the library sorts files, Standard until another is picked, saved before the files go in", async () => {
    server.items = [];
    const host = await mount();
    const files = [new File(["x"], "tiny-0.mp4", { type: "video/mp4" })];
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files, items: [], types: ["Files"] } });
    await act(async () => {
      host.firstElementChild!.dispatchEvent(drop);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const sort = document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[name="organize"]');
    expect(sort[0]!.checked).toBe(true);
    act(() => sort[1]!.click());
    const go = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === "Upload") as HTMLButtonElement;
    await act(async () => {
      go.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(server.patched).toEqual([{ settings: { organize: "ai", organizeOffered: true } }]);
    expect(server.sent[0]).toBe("save");
    expect(server.sent).toContain("upload tiny-0.mp4");
    for (const name of ["A-roll", "B-roll", "Music", "Sound effects", "Graphics", "Examples"]) expect(host.textContent).toContain(name);
  });

  it("a library whose organize is chosen is not asked again", async () => {
    server.items = [];
    server.settings = { organize: "own" };
    const host = await mount();
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [new File(["x"], "tiny-0.mp4", { type: "video/mp4" })], items: [], types: ["Files"] } });
    await act(async () => {
      host.firstElementChild!.dispatchEvent(drop);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull(); // a small upload goes straight in
    expect(server.sent).toContain("upload tiny-0.mp4");
  });

  it("a library whose only clips are in the trash is not the first screen: the Trash stays reachable", async () => {
    server.items = [];
    server.trash = [clip("gone")];
    const host = await mount();
    expect(buttons(host)).not.toContain("Choose a folder");
    expect(host.querySelector('[role="searchbox"]')).not.toBeNull();
  });

  it("a footage folder with no clips yet says so, not the first screen", async () => {
    server.items = [];
    server.watch = { allowed: true, folders: [{ path: "/Users/tiny/Movies/Trip", mode: "reference", addedBy: "admin", found: true, imported: 0, files: 0, adding: 0 }], missing: 0 };
    const host = await mount();
    expect(host.textContent).toContain("No clips");
    expect(buttons(host)).not.toContain("Choose a folder");
  });

  it("shows no Finals: not the folder the Finals tool reads, not a way to make one", async () => {
    server.folders = [
      { id: "col_f", name: "Finals", parentId: null, kind: "manual", count: 3, createdBy: "admin" },
      { id: "col_t", name: "Trip", parentId: null, kind: "manual", count: 1, createdBy: "admin" },
    ];
    const host = await mount();
    expect(host.textContent).not.toContain("Finals");
    await openMore(host);
    expect(moreItem("Library settings")).toBeDefined(); // the owner's one way to the settings
  });

  it("the settings button says so when a footage folder is not found (its drive unplugged)", async () => {
    server.watch = { allowed: true, folders: [{ path: "/Volumes/Card/Trip", mode: "reference", addedBy: "admin", found: false, imported: 3, files: 0, adding: 0 }], missing: 3 };
    const host = await mount();
    expect(more(host)?.getAttribute("aria-label")).toContain("not found");
  });

  it("Library settings holds the footage folders, storage and the AI switches; a hosted server has no footage folders", async () => {
    const host = await mount();
    const open = async () => {
      await openMore(host);
      await act(async () => moreItem("Library settings")!.click());
      await act(async () => new Promise((r) => setTimeout(r, 0)));
    };
    await open();
    const sheet = () => document.querySelector('[role="dialog"]')?.textContent ?? "";
    expect(sheet()).toContain("Footage folders");
    expect(sheet()).toContain("Storage");
    expect(sheet()).toContain("Search by meaning");
    expect(sheet()).toContain("Uses the AI provider");
    expect(sheet()).not.toContain("OpenAI key");
    act(() => root?.unmount());
    document.body.innerHTML = "";
    server.watch = { allowed: false, folders: [], missing: 0 };
    const hosted = await mount();
    await openMore(hosted);
    await act(async () => moreItem("Library settings")!.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(sheet()).toContain("Storage");
    expect(sheet()).not.toContain("Footage folders");
  });

  it("the A-roll and B-roll tabs ask the server for that roll, so the whole library is narrowed", async () => {
    server.items = [clip("talk", { roll: "a" }), clip("cover", { roll: "b" })];
    server.folders = [
      { id: "col_a", name: "A-roll", parentId: null, kind: "smart", query: { roll: "a" }, createdBy: "admin" },
      { id: "col_b", name: "B-roll", parentId: null, kind: "smart", query: { roll: "b" }, createdBy: "admin" },
    ];
    localStorage.setItem("library:view", "gallery"); // the tabs are the Gallery's
    const host = await mount();
    expect(host.querySelector('[data-tab="a"]')?.textContent).toBe("A-roll1");
    const b = host.querySelector('[data-tab="b"]') as HTMLButtonElement;
    await act(async () => b.click());
    expect(where()).toBe("?f=col_b"); // the folder, whose saved search the server runs
    expect(server.asked.at(-1)).toMatchObject({ collectionId: "col_b" });
    expect(server.asked.at(-1)).not.toHaveProperty("unfiled");
  });

  it("with every clip in a folder the B-roll tab still reaches into the folders", async () => {
    server.items = [clip("talk", { roll: "a" }), clip("cover", { roll: "b" })];
    server.filed = new Set(["talk", "cover"]);
    server.folders = [
      { id: "col_a", name: "A-roll", parentId: null, kind: "smart", query: { roll: "a" }, createdBy: "admin" },
      { id: "col_b", name: "B-roll", parentId: null, kind: "smart", query: { roll: "b" }, createdBy: "admin" },
      { id: "col_t", name: "Trip", parentId: null, kind: "manual", count: 2, createdBy: "admin" },
    ];
    localStorage.setItem("library:view", "gallery"); // the tabs are the Gallery's
    const host = await mount();
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const b = host.querySelector('[data-tab="b"]') as HTMLButtonElement;
    await act(async () => b.click());
    expect(where()).toBe("?f=col_b");
    expect(server.asked.at(-1)).not.toHaveProperty("unfiled");
  });

  it("offers no A-roll or B-roll tab when no such folder exists, sorted clips or not; a renamed one has its new name", async () => {
    server.items = [clip("cover", { roll: "b" })];
    localStorage.setItem("library:view", "gallery"); // the tabs are the Gallery's
    const host = await mount();
    expect(host.querySelector('[data-tab="a"]')).toBeNull();
    expect(host.querySelector('[data-tab="b"]')).toBeNull();
    act(() => root?.unmount());
    document.body.innerHTML = "";
    server.folders = [{ id: "col_b", name: "Footage", parentId: null, kind: "smart", query: { roll: "b" }, createdBy: "admin" }];
    const renamed = await mount();
    expect(renamed.querySelector('[data-tab="b"]')?.textContent).toBe("Footage1");
  });

  it("the Folders and List views show the folders and no tabs", async () => {
    server.folders = [
      { id: "col_a", name: "A-roll", parentId: null, kind: "smart", query: { roll: "a" }, createdBy: "admin" },
      { id: "col_b", name: "B-roll", parentId: null, kind: "smart", query: { roll: "b" }, createdBy: "admin" },
    ];
    const host = await mount();
    expect(host.querySelector('nav[aria-label="Library tabs"]')).toBeNull();
    expect(host.querySelector('a[href="/library?f=col_b"]')).not.toBeNull();
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
    expect(host.textContent).toContain("Could not read the file");
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
    expect(server.asked).toContainEqual(expect.objectContaining({ unfiled: true }));
    await openMore(host);
    expect(moreItem("Trash")?.getAttribute("href")).toBe("/library?trash=1");
    expect(buttons(host)).toContain("New folder");
  });

  it("a folder opens from the address under its tab, a folder inside it with the trail back up; a clip dropped on one moves there", async () => {
    server.folders = folders;
    localStorage.setItem("library:view", "gallery"); // the tabs are the Gallery's
    const nested = await mount("/library?f=col_b");
    expect(nested.querySelector('nav[aria-label="Folder"]')?.textContent).toBe("TinyTripBeach");
    expect(nested.querySelector('[data-tab="col_t"]')?.getAttribute("aria-current")).toBe("page");
    act(() => root?.unmount());
    document.body.innerHTML = "";
    const tabbed = await mount("/library?f=col_t");
    expect(tabbed.querySelector('[data-tab="col_t"]')?.getAttribute("aria-current")).toBe("page");
    expect(tabbed.querySelector('nav[aria-label="Folder"]')).toBeNull(); // the tab says where
    act(() => root?.unmount());
    document.body.innerHTML = "";
    localStorage.setItem("library:view", "folders"); // no tabs: the trail says where, the folders inside are cards
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

  it("a saved search takes no drops; opened, it runs its search (what is said too) and has no New folder", async () => {
    server.folders = folders;
    const top = await mount();
    await act(async () => drop(link(top, "Apples")!, "one"));
    expect(server.changed).toEqual([]);
    act(() => root?.unmount());
    document.body.innerHTML = "";
    const inside = await mount("/library?f=col_s");
    expect(inside.querySelector('nav[aria-label="Folder"]')?.textContent).toBe("TinyApples");
    expect(server.searched).toEqual(["apples"]);
    expect(inside.textContent).toContain("Tiny Acrobatics one");
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

describe("Media Library picks, menu, keys, link and drop", () => {
  const cards = (host: HTMLElement) => [...host.querySelector("main")!.querySelectorAll<HTMLElement>("[data-keep-picked]")];
  const click = (el: Element, o: MouseEventInit = {}) => act(async () => void el.querySelector("button[data-state]")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...o })));
  const key = (k: string, o: KeyboardEventInit = {}, target: EventTarget = window) =>
    act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o })));
  const bar = () => document.querySelector('[role="toolbar"][aria-label="Selected clips"]');
  beforeEach(() => {
    server.items = [clip("one"), clip("two"), clip("three")];
  });

  it("⌘-click picks a clip without opening it, Shift-click picks the run, and the bar says how many", async () => {
    const host = await mount();
    const [one, , three] = cards(host);
    await click(one, { metaKey: true });
    expect(where()).toBe("");
    expect(one.dataset.picked).toBe("true");
    await click(three, { shiftKey: true });
    expect(cards(host).map((c) => !!c.dataset.picked)).toEqual([true, true, true]);
    expect(bar()?.textContent).toContain("3 selected");
    await click(one, { metaKey: true });
    expect(bar()?.textContent).toContain("2 selected");
  });

  it("the bar's Trash moves every picked clip to the trash and takes them off the page", async () => {
    const host = await mount();
    const [one, two] = cards(host);
    await click(one, { metaKey: true });
    await click(two, { metaKey: true });
    await act(async () => (bar()!.querySelector('[aria-label="Move to trash"]') as HTMLButtonElement).click());
    await settle();
    expect(server.trashed.sort()).toEqual(["one", "two"]);
    expect(host.textContent).not.toContain("Tiny Acrobatics one");
    expect(host.textContent).toContain("Tiny Acrobatics three");
    expect(bar()).toBeNull();
  });

  it("⌘A picks every clip shown, but not while typing in the search", async () => {
    const host = await mount();
    await key("a", { metaKey: true }, host.querySelector('[role="searchbox"]')!);
    expect(bar()).toBeNull();
    await key("a", { metaKey: true });
    expect(bar()?.textContent).toContain("3 selected");
  });

  it("Escape clears the picks first, then the search", async () => {
    const host = await mount();
    const search = host.querySelector<HTMLInputElement>('[role="searchbox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "beach");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(cards(host)[0], { metaKey: true });
    await key("Escape");
    expect(bar()).toBeNull();
    expect(search.value).toBe("beach");
    await key("Escape");
    expect(search.value).toBe("");
  });

  it("a plain click opens the clip and puts it in the address; the address opens it too", async () => {
    const host = await mount();
    await click(cards(host)[1]);
    expect(where()).toBe("?clip=two");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => root?.unmount());
    document.body.innerHTML = "";
    await mount("/library?clip=three");
    await settle();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Tiny Acrobatics three");
  });

  it("right-click offers the clip's moves", async () => {
    const host = await mount();
    await act(async () => void cards(host)[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    const menu = document.querySelector('[role="menu"]')?.textContent ?? "";
    for (const item of ["Open", "Share…", "Download", "Copy link", "Add tag", "Move to trash"]) expect(menu).toContain(item);
  });

  it("asks the server for the order picked, kept on this device", async () => {
    localStorage.setItem("library:sort", "longest");
    await mount();
    expect(server.asked.at(-1)).toMatchObject({ sort: "longest" });
  });

  it("files dropped on the page are added", async () => {
    server.settings = { organize: "own" }; // asked already: no dialog first
    const host = await mount();
    const file = new File(["x"], "Tiny drop.mp4", { type: "video/mp4" });
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], files: [file], items: [{ webkitGetAsEntry: () => ({ isFile: true, isDirectory: false }) }] } });
    await act(async () => void host.querySelector("main")!.dispatchEvent(e));
    await settle();
    await settle();
    expect(server.uploaded).toEqual(["Tiny drop.mp4"]);
    expect(host.querySelector('[aria-label="Uploads"]')?.textContent).toContain("Tiny drop.mp4");
  });

  it("a waiting file cancelled and retried goes once: the queue does not send it again when its turn comes", async () => {
    server.settings = { organize: "own" };
    const host = await mount();
    let letGo = () => {};
    server.uploading = new Promise((r) => (letGo = r));
    const files = ["Tiny one.mp4", "Tiny two.mp4"].map((n) => new File(["x"], n, { type: "video/mp4" }));
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], files, items: files.map(() => ({ webkitGetAsEntry: () => ({ isFile: true, isDirectory: false }) })) } });
    await act(async () => void host.querySelector("main")!.dispatchEvent(e));
    await settle();
    await settle();
    expect(server.uploaded).toEqual(["Tiny one.mp4"]); // on its way; the second waits
    const press = (find: (b: HTMLButtonElement) => boolean) => act(async () => [...host.querySelectorAll("button")].find(find)!.click());
    await press((b) => b.getAttribute("aria-label") === "Cancel Tiny two.mp4");
    await press((b) => b.textContent === "Retry");
    await settle();
    letGo();
    await settle();
    await settle();
    expect(server.uploaded).toEqual(["Tiny one.mp4", "Tiny two.mp4"]);
  });
});

describe("Media Library layout, tabs, instant moves and menus", () => {
  const folders = [
    { id: "col_a", name: "A-roll", parentId: null, kind: "smart", query: { roll: "a" }, createdBy: "admin" },
    { id: "col_b", name: "B-roll", parentId: null, kind: "smart", query: { roll: "b" }, createdBy: "admin" },
    { id: "col_m", name: "Music", parentId: null, kind: "manual", count: 0, createdBy: "admin" },
  ];
  const tab = (host: HTMLElement, id: string) => host.querySelector(`[data-tab="${id}"]`) as HTMLElement | null;
  const dropOn = (el: Element, id: string) => {
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types: ["application/x-ct-media-item"], getData: (t: string) => (t === "application/x-ct-media-item" ? id : ""), files: [] } });
    el.dispatchEvent(e);
  };
  const rightClick = (el: Element) => {
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    el.dispatchEvent(e);
    return e;
  };
  const menuItem = (text: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((x) => x.textContent?.includes(text));

  it("the bar on top keeps the workspace and leaves Upload, New folder and Trash to the page's own row", async () => {
    const host = await mount();
    const bar = host.querySelector("[data-appbar]")!;
    expect(bar.textContent).not.toContain("Upload");
    expect(bar.querySelector('a[aria-label="Trash"]')).toBeNull();
    expect(buttons(host)).toEqual(expect.arrayContaining(["Upload", "New folder"]));
    await openMore(host);
    expect(moreItem("Trash")).toBeDefined();
    expect(host.querySelector('[aria-label="Kind"]')).toBeNull(); // the kinds are in the sidebar now
    expect(host.querySelector('aside [aria-label="Kinds"]')).not.toBeNull();
  });

  it("the tabs are All, A-roll, B-roll, Photos, then the top folders, with counts", async () => {
    localStorage.setItem("library:view", "gallery"); // the tabs are the Gallery's
    server.folders = folders;
    server.items = [clip("talk", { roll: "a" }), clip("pic", { kind: "image" })];
    const host = await mount();
    expect([...host.querySelectorAll('nav[aria-label="Library tabs"] button')].map((b) => b.textContent)).toEqual(["All", "A-roll1", "B-roll0", "Photos1", "Music0"]);
    await act(async () => tab(host, "photos")!.click());
    expect(server.asked.at(-1)).toMatchObject({ kind: ["image"] });
    await act(async () => tab(host, "a")!.click());
    expect(where()).toBe("?f=col_a");
  });

  it("a clip moved onto a folder's tab stays in the Gallery's All; Undo takes it back out, then asks the server", async () => {
    localStorage.setItem("library:view", "gallery"); // the tabs are the Gallery's
    server.folders = folders;
    server.items = [clip("one"), clip("two")];
    const host = await mount();
    let answer!: () => void;
    server.gate = new Promise((r) => (answer = r));
    await act(async () => dropOn(tab(host, "col_m")!, "one"));
    expect(host.textContent).toContain("Tiny Acrobatics one"); // All shows every clip, filed or not
    act(() => void undoLatest());
    expect(host.textContent).toContain("Tiny Acrobatics one");
    answer();
    await settle();
    await settle();
    expect(server.changed).toEqual([
      ["lib_tiny", "col_m", ["one"], true],
      ["lib_tiny", "col_m", ["one"], false],
    ]);
  });

  it("a clip dropped on the B-roll tab is filed so, and Undo files it as nothing again; a photo is never sent", async () => {
    localStorage.setItem("library:view", "gallery"); // the tabs are the Gallery's
    server.folders = folders;
    server.items = [clip("talk", { roll: "a" }), clip("pic", { kind: "image" })];
    const host = await mount();
    await act(async () => dropOn(tab(host, "b")!, "pic"));
    expect(server.changed).toEqual([]);
    await act(async () => dropOn(tab(host, "b")!, "talk"));
    await settle();
    expect(server.changed).toEqual([["lib_tiny", "col_b", ["talk"], true]]);
    await act(async () => void undoLatest());
    await settle();
    expect(server.changed.at(-1)).toEqual(["lib_tiny", "col_b", ["talk"], false]);
  });

  it("right-click on the empty space offers New folder and Upload; the browser's own menu never shows", async () => {
    const host = await mount();
    let e!: MouseEvent;
    await act(async () => void (e = rightClick(host.querySelector("[data-space-menu]")!)));
    expect(e.defaultPrevented).toBe(true);
    expect(menuItem("New folder")).toBeDefined();
    expect(menuItem("Upload…")).toBeDefined();
    let elsewhere!: MouseEvent;
    await act(async () => void (elsewhere = rightClick(host.querySelector("main")!)));
    expect(elsewhere.defaultPrevented).toBe(true);
  });

  it("a folder's tab menu deletes it at once and Undo brings it back", async () => {
    localStorage.setItem("library:view", "gallery"); // the tabs are the Gallery's
    server.folders = folders;
    const host = await mount();
    await act(async () => void rightClick(tab(host, "col_m")!));
    expect(menuItem("Rename…")).toBeDefined();
    expect(menuItem("New folder inside")).toBeDefined();
    await act(async () => menuItem("Delete folder")!.click());
    expect(tab(host, "col_m")).toBeNull();
    await settle();
    expect(server.changed).toContainEqual(["delete", "col_m"]);
    await act(async () => void undoLatest());
    expect(tab(host, "col_m")).not.toBeNull();
    await settle();
    expect(server.changed).toContainEqual(["restore", "col_m"]);
  });

  it("the Gallery shows only clips, from the whole library, and the pick is kept on this device", async () => {
    server.folders = folders;
    const host = await mount();
    expect(host.querySelector('a[href="/library?f=col_m"]')).not.toBeNull(); // Folders: the folder cards
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "View")!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Gallery"]')!.click());
    expect(host.querySelector('a[href="/library?f=col_m"]')).toBeNull();
    expect(server.asked.at(-1)).not.toHaveProperty("unfiled");
    expect(localStorage.getItem("library:view")).toBe("gallery");
  });

  it("a library given to look at has no Upload, New folder, Trash, page menu or drops", async () => {
    localStorage.setItem("library:view", "gallery"); // the tabs are the Gallery's
    server.readOnly = true;
    server.folders = folders;
    const host = await mount();
    expect(buttons(host)).not.toContain("Upload");
    expect(buttons(host)).not.toContain("New folder");
    if (more(host)) await openMore(host);
    expect(moreItem("Trash")).toBeUndefined();
    expect(host.querySelector("[data-space-menu]")).toBeNull();
    await act(async () => dropOn(tab(host, "col_m")!, "one"));
    expect(server.changed).toEqual([]);
  });
});
