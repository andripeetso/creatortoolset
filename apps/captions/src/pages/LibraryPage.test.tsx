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

type Card = { id: string; title: string; kind: string; state: string; thumbUrl?: string; roll?: "a" | "b"; blur?: "yes" | "no"; tags: string[]; aiTags: string[] };
const clip = (id: string, more: Partial<Card> = {}): Card => ({ id, title: `Tiny Acrobatics ${id}`, kind: "video", state: "ready", tags: [], aiTags: [], ...more });
const server = vi.hoisted(() => ({
  madeWait: null as Promise<void> | null, // holds What's made's read open while set
  retried: [] as string[],
  items: [] as unknown[],
  trash: [] as unknown[],
  folders: [] as unknown[],
  /** the plug-in sources this library offers (its Source picker) */
  sources: [] as { id: string; label: string }[],
  watch: { allowed: true, folders: [] as unknown[], missing: 0 } as unknown,
  scans: 0,
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
  faceBlur: false, // the Face Blur plug-in on, and this person may keep files as filmed
  gate: undefined as Promise<void> | undefined,
  /** a test holds every upload until it lets go */
  uploading: undefined as Promise<void> | undefined,
  /** redo asks: the kind, the clips ("all" = the library) and whether it was only a count */
  redone: [] as { kinds: string[]; ids: string[] | "all"; count: boolean }[],
  /** clips per page of the listing (0: all on one page); the cursor is the index the next page starts at */
  pageSize: 0,
  /** Select all's read of the remaining pages waits for this while set */
  holdAll: undefined as Promise<void> | undefined,
}));

vi.mock("@/lib/library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/library")>()),
  listLibraries: async () => [
    { id: "lib_tiny", name: "Tiny", storage: "local", settings: { describe: true, embed: false, setupAt: "2026-11-01T00:00:00.000Z", ...server.settings }, ...(server.readOnly ? { readOnly: true } : {}), ...(server.faceBlur ? { mayKeepAsFilmed: true } : {}) },
  ],
  // Default folders makes the six folders (api/library/organize.ts)
  uploadFile: async (_: string, f: File) => {
    server.sent.push(`upload ${f.name}`);
    server.uploaded.push(f.name);
    await server.uploading;
    return { assetId: "new" };
  },
  setAssetBlur: async (_: string, id: string, blur: string) => {
    server.sent.push(`blur ${id} ${blur}`);
    return { blur };
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
  listAssets: async (_: string, q: { trashed?: boolean; roll?: "a" | "b"; unfiled?: boolean; cursor?: string }) => {
    server.asked.push(q);
    const items = ((q.trashed ? server.trash : server.items) as Card[]).filter((x) => (!q.roll || x.roll === q.roll) && !(q.unfiled && server.filed.has(x.id)));
    if (!server.pageSize) return { items, next: null };
    const at = Number(q.cursor ?? 0);
    const end = at + server.pageSize;
    return { items: items.slice(at, end), next: end < items.length ? String(end) : undefined };
  },
  // Select all reads the rest of the view through the stand-in above, page by page
  listAllAssets: async (lib: string, q: { cursor?: string }) => {
    await server.holdAll; // a test holds Select all mid-read
    const { listAssets } = await import("@/lib/library");
    const all: Card[] = [];
    for (let cursor = q.cursor; cursor; ) {
      const page = (await listAssets(lib, { ...q, cursor })) as { items: Card[]; next?: string };
      all.push(...page.items);
      cursor = page.next;
    }
    return all;
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
  scanWatchNow: async () => {
    server.scans++;
    return { added: 2, settling: 1 };
  },
  getProgress: async () => ({ done: 0, left: 0, clips: 0, seconds: 0, waiting: [] }),
  getLibraryStorage: async () => ({ kind: "local", keysSet: false, serverBucket: false, locked: true, days: [] }),
  listTags: async () => [{ tag: "beach", count: 2 }],
  listPlaces: async () => [],
  renameCollection: async (_: string, id: string, name: string) => void server.changed.push(["rename", id, name]),
  folderBlur: async (_: string, id: string, blur: string | null) => void server.changed.push(["blur", id, blur]),
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
  redoMany: async (_: string, kinds: string[], assetIds?: string[], count?: boolean) => {
    server.redone.push({ kinds, ids: assetIds ?? "all", count: !!count });
    return { clips: server.items.length };
  },
  getEstimate: async () => ({ clips: 1, minutes: 0, seconds: 0, steps: [{ step: "describe", route: "provider", usd: 0, seconds: 1, measured: false }] }),
  getStatus: async () => ({ clips: 3, unreadable: 0, stages: [{ kind: "transcribe", done: 2, failed: 1, open: 0, of: 3 }] }),
  getMade: async () => (await server.madeWait, [{ kind: "transcribe", have: 2, missing: 1, queued: 0, failed: 1, cost: "free", broll: 1 }]),
  retryFailed: async (_: string, kind: string) => {
    server.retried.push(kind);
    return { files: 1 };
  },
}));

vi.mock("./library/face-blur", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./library/face-blur")>()),
  faceBlurOn: () => server.faceBlur,
}));

vi.mock("./library/api", () => ({
  tabCounts: async () => {
    const items = server.items as Card[];
    return { a: items.filter((x) => x.roll === "a").length, b: items.filter((x) => x.roll === "b").length, image: items.filter((x) => x.kind === "image").length, video: items.filter((x) => x.kind === "video").length };
  },
  setFolderRule: async (_: string, id: string, rule: string | null) => void server.changed.push(["rule", id, rule]),
  restoreFolder: async (_: string, id: string) => {
    server.changed.push(["restore", id]);
    return { id };
  },
}));

const { default: LibraryPage } = await import("./LibraryPage");
const { resetImportQueue } = await import("@/lib/import-queue");
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
  server.faceBlur = false;
  server.gate = undefined;
  server.uploading = undefined;
  server.redone = [];
  server.pageSize = 0;
  server.holdAll = undefined;
  server.scans = 0;
  server.retried = [];
  server.madeWait = null;
  localStorage.clear();
});
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  root = null;
  resetImportQueue(); // the queue is the app's: it outlives the page, so each test starts with none
});

/** The address the page is at, for the tests to read. */
function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.search}</output>;
}
const where = () => document.querySelector('[data-testid="where"]')?.textContent ?? "";
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
// every add asks its one sheet (./library/ImportChoices.tsx): Add takes what it starts from
const pressAdd = async () => {
  await settle();
  const add = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === "Add") as HTMLElement | undefined;
  expect(add).toBeTruthy();
  await act(async () => add!.click());
  await settle();
};

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
  // replaced (CEO 11-19, Andri): the empty Library is one drop box, nothing else on the page (no toolbar until the first clip)
  // replaced (Andri 13:00 sign-off: C1, a small box with a drawing, Drop media here and a Choose files button)
  it("an empty library is one drop box: no toolbar, Drop media here, and Choose files opens the file window", async () => {
    server.items = [];
    const host = await mount();
    expect(host.querySelector('[role="searchbox"]')).toBeNull();
    expect(more(host)).toBeNull();
    expect(buttons(host)).not.toContain("Upload");
    expect(buttons(host)).not.toContain("New folder");
    expect(host.querySelector('[aria-label^="Sort by"]')).toBeNull();
    expect(host.textContent).toContain("Drop media here");
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, "click").mockImplementation(() => {});
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Choose files")!.click());
    expect(click).toHaveBeenCalledTimes(1);
  });

  // CEO 11-19 library-menu (Andri: "a button to check the source folder for new media")
  it("Look for new files is in the ⋯ menu after Library status: it reads the folders now and says what it found", async () => {
    const host = await mount();
    await openMore(host);
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((x) => x.textContent?.trim() ?? "");
    expect(items.findIndex((t) => t.includes("Look for new files"))).toBeGreaterThan(items.findIndex((t) => t.includes("Library status")));
    await act(async () => moreItem("Look for new files")!.click());
    await settle();
    expect(server.scans).toBe(1);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Added 2 · 1 coming in");
  });

  it("Library status opens over the library: the files, and What's made with each kind's state and Retry; Esc closes it and the library stays", async () => {
    localStorage.setItem("library:view", "status"); // a view kept from before Status was a dialog opens as Folders
    const host = await mount();
    // the status button's dot: a kind failed
    expect(host.querySelector('[aria-label="Library status: Failed"]')).not.toBeNull();
    await openMore(host);
    await act(async () => moreItem("Library status")!.click());
    await settle();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect([...dialog.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["Library status", "Files", "What's made"]);
    expect(dialog.textContent).toContain("1 file failed · 2 of 4 made");
    await act(async () => [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click());
    expect(server.retried).toEqual(["transcribe"]);
    // Include B-roll, the one switch here (the New files switches are Settings'): off and on again saves the library's choice
    const broll = () => dialog.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Include B-roll"]')!;
    expect(dialog.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(broll().getAttribute("aria-checked")).toBe("true");
    // the setting saved and the list still being read again: the switch holds the new value, never flips back
    let release = () => {};
    server.madeWait = new Promise((r) => (release = r));
    await act(async () => broll().click());
    expect(server.patched.at(-1)).toEqual({ settings: { transcribeBroll: false } });
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(broll().getAttribute("aria-checked")).toBe("false");
    server.madeWait = null;
    release();
    await settle();
    expect(broll().getAttribute("aria-checked")).toBe("false");
    await act(async () => broll().click());
    expect(server.patched.at(-1)).toEqual({ settings: { transcribeBroll: true } });
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toContain("What's made");
  });

  it("a library given to look at only has no Look for new files", async () => {
    server.readOnly = true;
    const host = await mount();
    await openMore(host);
    expect(moreItem("Library status")).toBeUndefined(); // its counts are the owner's
    expect(moreItem("Look for new files")).toBeUndefined();
  });

  it("an empty library given to look at says No clips yet, with no drop box", async () => {
    server.items = [];
    server.readOnly = true;
    const host = await mount();
    expect(host.textContent).toContain("No clips yet");
    expect(host.textContent).not.toContain("Drop media here");
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

  // replaced (CEO 11-19 import-flow): a drop asks nothing first (no "Add N files?", no sort question: setup chose them)
  it("a drop asks its one sheet, and once Add is pressed the file is sent", async () => {
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
    await settle();
    expect(server.uploaded).toEqual([]);
    await pressAdd();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(server.uploaded).toEqual(["tiny-0.mp4"]);
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
    await pressAdd();
    expect(document.querySelector('[role="dialog"]')).toBeNull(); // no organize question after the sheet
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

  it("Library settings holds the owner sections in the §3.1 order (Folders, Organization, Proxy workflow, Hosted media, Analysis, Models)", async () => {
    const host = await mount();
    const open = async () => {
      await openMore(host);
      await act(async () => moreItem("Library settings")!.click());
      await act(async () => new Promise((r) => setTimeout(r, 0)));
    };
    await open();
    const sheet = () => document.querySelector('[role="dialog"]')?.textContent ?? "";
    const order = ["Folders", "Organization", "Proxy workflow", "Hosted media", "Analysis", "Models"].map((t) => sheet().indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(sheet()).not.toContain("How should imported media behave?"); // the import rule decides (BA PRD R1)
    expect(sheet()).not.toContain("OpenAI key");
    act(() => root?.unmount());
    document.body.innerHTML = "";
    server.watch = { allowed: false, folders: [], missing: 0 };
    const hosted = await mount();
    await openMore(hosted);
    await act(async () => moreItem("Library settings")!.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(sheet()).toContain("Organization");
    expect(sheet()).toContain("Search by meaning"); // What's made: one New files switch per kind
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

  it("⌘A also picks the clips on pages not loaded yet, each once", async () => {
    server.items = ["one", "two", "three", "four", "five"].map((id) => clip(id));
    server.pageSize = 2;
    const host = await mount();
    expect(cards(host)).toHaveLength(2);
    await key("a", { metaKey: true });
    await settle();
    expect(bar()?.textContent).toContain("5 selected");
    expect(cards(host).map((c) => !!c.dataset.picked)).toEqual([true, true, true, true, true]);
  });

  it("Escape while Select all reads the other pages: the pages load, nothing is picked", async () => {
    server.items = ["one", "two", "three", "four", "five"].map((id) => clip(id));
    server.pageSize = 2;
    let answer!: () => void;
    server.holdAll = new Promise((r) => (answer = r));
    const host = await mount();
    await click(cards(host)[0]!, { metaKey: true });
    await key("a", { metaKey: true });
    expect(bar()?.textContent).toContain("Selecting");
    await key("Escape");
    answer();
    await settle();
    expect(cards(host)).toHaveLength(5);
    expect(bar()).toBeNull();
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

  it("right-click on a clip kept as filmed offers Blur faces where Face Blur is on, which queues its blur; any other clip has none", async () => {
    server.items = [clip("one", { blur: "no" }), clip("two")];
    const menuOf = async (host: HTMLElement, i: number) => {
      await act(async () => void cards(host)[i].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
      return [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent === "Blur faces") as HTMLElement | undefined;
    };
    // no Face Blur plug-in: nothing blurs, so nothing offers it
    expect(await menuOf(await mount(), 0)).toBeUndefined();
    act(() => root?.unmount());
    document.body.innerHTML = "";
    server.faceBlur = true; // set back after each test
    const host = await mount();
    expect(await menuOf(host, 1)).toBeUndefined();
    await key("Escape");
    const item = await menuOf(host, 0);
    expect(item).toBeDefined();
    await act(async () => item!.click());
    expect(server.sent).toContain("blur one yes");
  });

  it("asks the server for the order picked, kept on this device", async () => {
    localStorage.setItem("library:sort", "longest");
    await mount();
    expect(server.asked.at(-1)).toMatchObject({ sort: "longest" });
  });

  // Andri 13:00 sign-off C4: Sort by is a dropdown after View, which way is its own ↓/↑ button
  it("sorts by Date filmed, newest first, until another is picked; Sort by keeps the way, the order button turns it", async () => {
    localStorage.removeItem("library:sort");
    const host = await mount();
    expect(server.asked.at(-1)).toMatchObject({ sort: "filmed" });
    const by = host.querySelector<HTMLButtonElement>('[aria-label^="Sort by"]')!;
    expect(by.getAttribute("aria-label")).toBe("Sort by Date filmed");
    expect(host.querySelector('button[aria-label="Newest first"]')).not.toBeNull();
    await act(async () => by.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })));
    // replaced (CEO 11-19 list columns: the list's Size and Kind headers sort, so Sort by has them too)
    expect([...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent?.trim())).toEqual(["Date filmed", "Date added", "Name", "Length", "Size", "Kind"]);
    await act(async () => moreItem("Name")!.click());
    await settle();
    expect(server.asked.at(-1)).toMatchObject({ sort: "name" });
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="A → Z"]')!.click());
    await settle();
    expect(server.asked.at(-1)).toMatchObject({ sort: "name-za" });
    expect(host.querySelector('button[aria-label="Z → A"]')).not.toBeNull();
    expect(localStorage.getItem("library:sort")).toBe("name-za");
  });

  // replaced (CEO 11-19 import-flow): no Uploads list; each file is a card in the grid while it goes in
  it("files dropped on the page are added, each a card in the grid at once, and no list of uploads", async () => {
    server.settings = { organize: "own" };
    const host = await mount();
    const file = new File(["x"], "Tiny drop.mp4", { type: "video/mp4" });
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], files: [file], items: [{ webkitGetAsEntry: () => ({ isFile: true, isDirectory: false }) }] } });
    await act(async () => void host.querySelector("main")!.dispatchEvent(e));
    await pressAdd();
    await settle();
    await settle();
    expect(server.uploaded).toEqual(["Tiny drop.mp4"]);
    expect(host.querySelector("[data-placeholder]")?.textContent).toContain("Tiny drop.mp4");
    expect(host.querySelector('[aria-label="Uploads"]')).toBeNull();
    expect(host.textContent).not.toContain("Clear finished");
  });

  // replaced (CEO 11-19 import-flow): files go side by side, not one after another; one line counts them, with Cancel all
  it("a drop's files are on their way at the same time, with one line counting them until they are in", async () => {
    server.settings = { organize: "own" };
    const host = await mount();
    let letGo = () => {};
    server.uploading = new Promise((r) => (letGo = r));
    const files = ["Tiny one.mp4", "Tiny two.mp4"].map((n) => new File(["x"], n, { type: "video/mp4" }));
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], files, items: files.map(() => ({ webkitGetAsEntry: () => ({ isFile: true, isDirectory: false }) })) } });
    await act(async () => void host.querySelector("main")!.dispatchEvent(e));
    await pressAdd();
    await settle();
    await settle();
    expect(server.uploaded).toEqual(["Tiny one.mp4", "Tiny two.mp4"]); // both on their way; neither waits for the other
    expect(host.querySelectorAll("[data-placeholder]").length).toBe(2);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Adding 2 clips · 0 done");
    expect(host.textContent).toContain("Cancel all");
    letGo();
    await settle();
    await settle();
    expect(host.textContent).not.toContain("Adding 2 clips");
  });

  // CEO 11-19 import-queue: the import is the app's, not the page's
  it("leaving the Library and coming back keeps the drop going: its cards, the count and Cancel all", async () => {
    server.settings = { organize: "own" };
    const host = await mount();
    let letGo = () => {};
    server.uploading = new Promise((r) => (letGo = r));
    const files = ["Tiny one.mp4", "Tiny two.mp4", "Tiny three.mp4"].map((n) => new File(["x"], n, { type: "video/mp4" }));
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], files, items: files.map(() => ({ webkitGetAsEntry: () => ({ isFile: true, isDirectory: false }) })) } });
    await act(async () => void host.querySelector("main")!.dispatchEvent(e));
    await pressAdd();
    await settle();
    expect(host.querySelectorAll("[data-placeholder]").length).toBe(3);
    // another tool: the page goes away, the files don't
    act(() => root!.unmount());
    document.body.innerHTML = "";
    const back = await mount();
    await settle();
    expect(back.querySelectorAll("[data-placeholder]").length).toBe(3);
    expect(back.querySelector('[role="status"]')?.textContent).toContain("Adding 3 clips · 0 done");
    await act(async () => void [...back.querySelectorAll("button")].find((b) => b.textContent === "Cancel all")!.click());
    expect(back.querySelectorAll("[data-placeholder]").length).toBe(0);
    expect(back.textContent).not.toContain("Adding 3 clips");
    letGo();
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
    expect(host.querySelector('[aria-label="Kind"]')).toBeNull(); // the tabs pick the kind
    expect(host.querySelector('aside [aria-label="Kinds"]')).toBeNull();
    expect(host.querySelector('aside [aria-label="Orientation"]')).not.toBeNull();
  });

  it("names what the sidebar narrows to above the list, each with its X, and Clear lets go of all", async () => {
    const host = await mount();
    const pill = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("aside button")].find((b) => b.textContent === text)!;
    const row = () => host.querySelector('[role="group"][aria-label="Filters"]');
    expect(row()).toBeNull();
    await act(async () => pill("Vertical").click());
    await act(async () => pill("This year").click());
    expect(row()!.textContent).toContain("Vertical");
    expect(row()!.textContent).toContain("This year");
    await act(async () => row()!.querySelector<HTMLButtonElement>('[aria-label="Remove Vertical"]')!.click());
    expect(pill("Vertical").getAttribute("aria-pressed")).toBe("false");
    await act(async () => [...row()!.querySelectorAll("button")].find((b) => b.textContent === "Clear")!.click());
    expect(row()).toBeNull();
  });

  it("the tabs are All, A-roll, B-roll, Videos, Photos, then the top folders, with counts", async () => {
    localStorage.setItem("library:view", "gallery"); // the tabs are the Gallery's
    server.folders = folders;
    server.items = [clip("talk", { roll: "a" }), clip("pic", { kind: "image" })];
    const host = await mount();
    expect([...host.querySelectorAll('nav[aria-label="Library tabs"] button')].map((b) => b.textContent)).toEqual(["All", "A-roll1", "B-roll0", "Videos1", "Photos1", "Music0"]);
    await act(async () => tab(host, "videos")!.click());
    expect(server.asked.at(-1)).toMatchObject({ kind: ["video"] });
    await act(async () => tab(host, "photos")!.click());
    expect(server.asked.at(-1)).toMatchObject({ kind: ["image"] });
    await act(async () => tab(host, "a")!.click());
    expect(where()).toBe("?f=col_a");
  });

  it("All, Videos and Photos hide from their right-click menu and come back from Tab settings", async () => {
    localStorage.setItem("library:view", "gallery");
    server.folders = folders;
    server.items = [clip("talk", { roll: "a" }), clip("pic", { kind: "image" })];
    const host = await mount();
    // the open tab hidden: it goes, and the next tab still shown opens
    await act(async () => void rightClick(tab(host, "all")!));
    await act(async () => menuItem("Hide tab")!.click());
    await settle();
    expect(tab(host, "all")).toBeNull();
    expect(where()).toBe("?f=col_a");
    for (const id of ["videos", "photos"]) {
      await act(async () => void rightClick(tab(host, id)!));
      await act(async () => menuItem("Hide tab")!.click());
      expect(tab(host, id)).toBeNull();
    }
    // a tab's own menu has the row's items too: New tab, and Tab settings where the hidden ones come back
    await act(async () => void rightClick(tab(host, "b")!));
    expect(menuItem("New tab")).toBeDefined();
    await act(async () => menuItem("Tab settings")!.click());
    const photos = document.querySelector<HTMLElement>('[role="switch"][aria-label="Photos"]')!;
    expect(photos.getAttribute("aria-checked")).toBe("false");
    await act(async () => photos.click());
    expect(tab(host, "photos")).not.toBeNull();
    expect(tab(host, "videos")).toBeNull();
  });

  it("with All hidden the library opens on the first tab still shown", async () => {
    localStorage.setItem("library:view", "gallery");
    localStorage.setItem("ct.library.hiddenTabs.lib_tiny", JSON.stringify(["all"]));
    server.folders = folders;
    const host = await mount();
    await settle();
    expect(tab(host, "all")).toBeNull();
    expect(where()).toBe("?f=col_a");
  });

  it("with All hidden, Photos to B-roll never draws All on the way (it flashed and sent the page to the first tab)", async () => {
    localStorage.setItem("library:view", "gallery");
    localStorage.setItem("ct.library.hiddenTabs.lib_tiny", JSON.stringify(["all"]));
    server.folders = folders;
    server.items = [clip("pic", { kind: "image" })];
    const host = await mount();
    await settle();
    await act(async () => tab(host, "photos")!.click());
    let drewAll = false;
    // the records, not the page: the observer is told after both renders, when All is gone again
    const isAll = (n: Node) => n instanceof Element && (n.matches('[data-tab="all"]') || !!n.querySelector('[data-tab="all"]'));
    const seen = new MutationObserver((rs) => void (drewAll ||= rs.some((r) => [...r.addedNodes].some(isAll))));
    seen.observe(host, { childList: true, subtree: true, attributes: true });
    await act(async () => tab(host, "b")!.click());
    await settle();
    seen.disconnect();
    expect(drewAll).toBe(false);
    expect(where()).toBe("?f=col_b");
  });

  it("a kind picked on a Gallery tab goes with the tabs when the view changes", async () => {
    localStorage.setItem("library:view", "gallery");
    const host = await mount();
    await act(async () => tab(host, "videos")!.click());
    expect(server.asked.at(-1)).toMatchObject({ kind: ["video"] });
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "View")!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="List"]')!.click());
    expect(server.asked.at(-1)?.kind).toBeUndefined();
  });

  it("a top folder called Photos is the only Photos tab", async () => {
    localStorage.setItem("library:view", "gallery");
    server.folders = [...folders, { id: "col_p", name: "Photos", parentId: null, kind: "manual", count: 1, createdBy: "admin" }];
    server.items = [clip("pic", { kind: "image" })];
    const host = await mount();
    expect([...host.querySelectorAll('nav[aria-label="Library tabs"] button')].map((b) => b.textContent)).toEqual(["All", "A-roll0", "B-roll0", "Music0", "Photos1"]);
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

  it("Folder settings saves only the rows that changed", async () => {
    localStorage.setItem("library:view", "gallery");
    server.folders = folders;
    const host = await mount();
    await act(async () => void rightClick(tab(host, "col_m")!));
    await act(async () => menuItem("Folder settings")!.click());
    const name = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    expect(name.value).toBe("Music");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Songs");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Save")!.click());
    await settle();
    expect(server.changed).toContainEqual(["rename", "col_m", "Songs"]);
    expect(server.changed.some((c) => (c as unknown[])[0] === "rule")).toBe(false);
  });

  it("Folder settings turns Blur faces off for a folder only once the person agrees", async () => {
    localStorage.setItem("library:view", "gallery");
    server.folders = folders;
    server.faceBlur = true;
    let answer = false;
    window.confirm = () => answer;
    const host = await mount();
    const save = async () => {
      await act(async () => void rightClick(tab(host, "col_m")!));
      await act(async () => menuItem("Folder settings")!.click());
      await act(async () => document.querySelector<HTMLElement>('[role="dialog"] [role="checkbox"]')!.click());
      await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Save")!.click());
      await settle();
    };
    await save(); // asked, and said no: nothing sent, the window stays
    expect(server.changed.some((c) => (c as unknown[])[0] === "blur")).toBe(false);
    answer = true;
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Save")!.click());
    await settle();
    expect(server.changed).toContainEqual(["blur", "col_m", "no"]);
    (window as { confirm?: unknown }).confirm = undefined;
  });

  it("a folder's tab menu deletes it at once and Undo brings it back", async () => {
    localStorage.setItem("library:view", "gallery"); // the tabs are the Gallery's
    server.folders = folders;
    const host = await mount();
    await act(async () => void rightClick(tab(host, "col_m")!));
    expect(menuItem("Rename")).toBeDefined();
    expect(menuItem("Folder settings")).toBeDefined();
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

describe("Media Library redo: the ⋯ menu and the selection bar", () => {
  const all = ["Descriptions", "Shot descriptions", "Transcripts", "Search data"];
  const click = (el: Element, o: MouseEventInit = {}) => act(async () => void el.querySelector("button[data-state]")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...o })));
  const bar = () => document.querySelector('[role="toolbar"][aria-label="Selected clips"]')!;
  const pointerOpen = (el: Element) => act(async () => void el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })));
  // the in-app dialog is not mounted here, so confirmDialog falls back to window.confirm: answered, and asked, by hand
  let answer = true;
  const asked: string[] = [];
  beforeEach(() => {
    server.items = [clip("one"), clip("two")];
    server.settings = { describe: true, look: true, embed: true, transcribe: true };
    answer = true;
    asked.length = 0;
    window.confirm = (msg?: string) => (asked.push(String(msg)), answer);
  });
  afterEach(() => {
    (window as { confirm?: unknown }).confirm = undefined;
  });

  it("the owner's ⋯ menu offers the four Redo items; one asks for its clips, then runs on the whole library", async () => {
    const host = await mount();
    await openMore(host);
    for (const label of all) expect(moreItem(label), label).toBeDefined();
    await act(async () => moreItem("Transcripts")!.click());
    await settle();
    expect(asked[0]).toContain("For 2 clips");
    expect(server.redone).toEqual([
      { kinds: ["transcribe"], ids: "all", count: true },
      { kinds: ["transcribe"], ids: "all", count: false },
    ]);
  });

  it("a press that is not confirmed sends only the count", async () => {
    answer = false;
    const host = await mount();
    await openMore(host);
    await act(async () => moreItem("Search data")!.click());
    await settle();
    expect(server.redone).toEqual([{ kinds: ["embed"], ids: "all", count: true }]);
  });

  it("the owner page has no All clips group", async () => {
    const host = await mount();
    await openMore(host);
    await act(async () => moreItem("Library settings")!.click());
    await settle();
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("All clips");
  });

  it("Effort Off offers no Redo at all", async () => {
    server.settings = { describe: false, look: false, transcribe: false, embed: false };
    const host = await mount();
    await openMore(host);
    for (const label of all) expect(moreItem(label), label).toBeUndefined();
  });

  it("the selection bar's Redo runs the picked clips only, for each kind it offers", async () => {
    const host = await mount();
    await click(host.querySelector("main")!.querySelectorAll<HTMLElement>("[data-keep-picked]")[0], { metaKey: true });
    await act(async () => pointerOpen(bar().querySelector('button[title="Redo"]')!));
    for (const label of all) expect(moreItem(label), label).toBeDefined();
    await act(async () => moreItem("Search data")!.click());
    await settle();
    expect(server.redone).toEqual([{ kinds: ["embed"], ids: ["one"], count: false }]);
  });
});
