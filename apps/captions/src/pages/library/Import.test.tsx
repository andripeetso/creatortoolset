// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary } from "@contracts/library";
import type { PlacesReport } from "@contracts/places";
import { copyAvailable, copyPath, foldersHere, ImportCards, importAsk, lookedLine, lookForNew, NEEDS_MAC, placeOfFile } from "./Import";

const m = vi.hoisted(() => ({ getStorage: vi.fn(async () => ({ folders: [] as unknown[] })), importScan: vi.fn(), importPrint: vi.fn(), checkUpload: vi.fn(), versionPlaces: vi.fn(), reportPlaces: vi.fn(), indexOnMac: vi.fn() }));
vi.mock("@/lib/thisMac", async (orig) => ({ ...(await orig<typeof import("@/lib/thisMac")>()), importScan: m.importScan, importPrint: m.importPrint }));
vi.mock("@/lib/library", async (orig) => ({ ...(await orig<typeof import("@/lib/library")>()), checkUpload: m.checkUpload, versionPlaces: m.versionPlaces, reportPlaces: m.reportPlaces }));
vi.mock("@/components/settings/StorageRows", async (orig) => ({ ...(await orig<typeof import("@/components/settings/StorageRows")>()), getStorage: m.getStorage }));
vi.mock("@/lib/onMac", async (orig) => ({ ...(await orig<typeof import("@/lib/onMac")>()), indexOnMac: m.indexOnMac }));

// The import question: asked on the first add, not from a place the library knows, in short from a new place; a browser
// with the server elsewhere only says the files upload; an older Mac app can't copy.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = undefined;
  delete document.documentElement.dataset.macImport;
  delete document.documentElement.dataset.macDevice;
  vi.unstubAllGlobals();
});

const places = [{ path: "/Volumes/Tiny/Footage", mode: "in-place" as const }];

describe("what an add asks", () => {
  it("the first add asks the whole question", () => {
    expect(importAsk("mac", {}, ["/Users/tiny/Downloads"])).toEqual({ kind: "first" });
    expect(importAsk("here", {}, ["/Users/tiny/Downloads"])).toEqual({ kind: "first" });
  });

  it("an add from inside a known place asks nothing", () => {
    expect(importAsk("mac", { importMode: "in-place", places }, ["/Volumes/Tiny/Footage/Day 1"])).toBeNull();
  });

  it("an add from a new place asks in short, starting on the library's answer", () => {
    expect(importAsk("mac", { importMode: "copy", places }, ["/Volumes/Tiny/Footage", "/Users/tiny/Downloads"])).toEqual({ kind: "new", mode: "copy" });
  });

  it("a browser with the server elsewhere only says the files upload", () => {
    expect(importAsk("browser", {}, [])).toEqual({ kind: "upload" });
    expect(importAsk("browser", { importMode: "in-place", places }, ["/Volumes/Tiny/Footage"])).toEqual({ kind: "upload" });
  });

  it("copying needs the latest Mac app, except a folder the server on this computer copies", () => {
    vi.stubGlobal("webkit", { messageHandlers: { thisMac: { postMessage: async () => ({}) } } });
    expect(copyAvailable("mac")).toBe(false);
    expect(copyAvailable("here", true)).toBe(true);
    document.documentElement.dataset.macImport = "1";
    expect(copyAvailable("mac")).toBe(true);
    expect(copyAvailable("browser")).toBe(false);
  });

  it("an older Mac app shows the copy choice switched off, saying why", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<ImportCards legend="Import" value="in-place" onChange={() => {}} copy={{ to: null, off: NEEDS_MAC }} />));
    const copy = [...host.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Copy into the library"))!;
    expect(copy.querySelector("input")!.disabled).toBe(true);
    expect(copy.textContent).toContain("Needs the latest Mac app");
  });
});

describe("places and copies", () => {
  it("a file read from a dropped folder comes from that folder; a loose file from its own folder", () => {
    const inFolder = new File(["x"], "a.mp4");
    Object.defineProperty(inFolder, "webkitRelativePath", { value: "Trip/Day 1/a.mp4" });
    expect(placeOfFile(inFolder, "/Volumes/Card/Trip/Day 1/a.mp4")).toBe("/Volumes/Card/Trip");
    expect(placeOfFile(new File(["x"], "b.mp4"), "/Users/tiny/Downloads/b.mp4")).toBe("/Users/tiny/Downloads");
  });

  it("a copy goes into Footage, Audio or Pictures, under the place's own name", () => {
    expect(copyPath("~/Movies/Creator Toolset/Library", "/Volumes/Card/Trip", "/Volumes/Card/Trip/Day 1/a.mp4")).toBe("~/Movies/Creator Toolset/Library/Footage/Trip/Day 1/a.mp4");
    expect(copyPath("/Users/tiny/Lib/", "/Users/tiny/Downloads", "/Users/tiny/Downloads/song.mp3")).toBe("/Users/tiny/Lib/Audio/Downloads/song.mp3");
    expect(copyPath("/x", "/y", "/y/p.JPG")).toBe("/x/Pictures/y/p.JPG");
  });
});

describe("Look for new files", () => {
  it("reads this workspace's footage and music folders on this Mac: a clip uploaded before is reconnected to its file there", async () => {
    document.documentElement.dataset.macDevice = "mac_1";
    const folder = (role: string, path: string, workspace?: string, host = "mac_1") => ({ id: path, role, name: path, origin: { host, path }, make: false, createdAt: 0, reach: {}, ...(workspace ? { workspace } : {}) });
    const view = {
      folders: [
        folder("footage", "/Volumes/Tiny/Game", "Tiny Game"),
        folder("music", "/Volumes/Tiny/Game/Music", "Tiny Game"), // inside the one above: read with it
        folder("footage", "/Volumes/Tiny", "*"), // every workspace: a whole drive, left out
        folder("footage", "/Users/other/Footage", "Tiny Game", "mac_2"), // another computer's
        folder("finals", "/Volumes/Tiny/Finals", "Tiny Game"),
      ],
    };
    expect(foldersHere(view as never, "mac_1")).toEqual(["/Volumes/Tiny/Game"]);
    expect(foldersHere({ ...view, here: ["mac_1"] } as never, "mac_1")).toEqual([]); // the server reads this Mac itself

    m.getStorage.mockResolvedValueOnce(view);
    m.importScan.mockResolvedValue([{ path: "/Volumes/Tiny/Game/clip.mov", size: 7, mtime: 0 }]);
    m.importPrint.mockResolvedValue({ "/Volumes/Tiny/Game/clip.mov": "q-clip" });
    m.checkUpload.mockResolvedValue({ duplicateOf: "a_up", versionId: "v_up" });
    // uploaded: no computer has a path for it
    m.versionPlaces.mockResolvedValue({ versions: { v_up: { tries: [], bytes: 7, quick: "q-clip", proxy: null } } });
    m.reportPlaces.mockImplementation(async (_lib: string, r: PlacesReport) => ({ confirmed: r.confirmed.map((c) => c.versionId), refused: [] }));
    const library = { id: "lib", name: "Tiny Game", settings: {} } as unknown as LibrarySummary;
    expect(await lookForNew(library, () => undefined)).toEqual({ added: 0, reconnected: 1 });
    expect(m.importScan).toHaveBeenCalledWith("/Volumes/Tiny/Game");
    expect(m.reportPlaces).toHaveBeenCalledWith("lib", { device: "mac_1", confirmed: [{ versionId: "v_up", path: "/Volumes/Tiny/Game/clip.mov", quick: "q-clip" }], gone: [] });
  });

  it("adds what is new and reconnects a file the library has at a path this computer doesn't read it from", async () => {
    document.documentElement.dataset.macDevice = "mac_1";
    const at = (n: string) => `/Volumes/Tiny/Footage/${n}`;
    const scanned = ["new.mov", "moved.mov", "same.mov", "b/copy.mov", "a/copy.mov"];
    m.importScan.mockResolvedValue(scanned.map((n, i) => ({ path: at(n), size: i + 1, mtime: 0 })));
    m.importPrint.mockImplementation(async (paths: string[]) => Object.fromEntries(paths.map((p) => [p, `q-${p.split("/").pop()}`])));
    const known: Record<string, string> = { "q-moved.mov": "v_moved", "q-same.mov": "v_same", "q-copy.mov": "v_copy" };
    m.checkUpload.mockImplementation(async (_lib: string, _size: number, _sha: string, quick: string) =>
      known[quick] ? { duplicateOf: `a_${known[quick]}`, versionId: known[quick] } : {},
    );
    const tried = (tries: string[]) => ({ tries, bytes: 1, quick: null, proxy: null });
    m.versionPlaces.mockResolvedValue({
      versions: {
        // moved since: this computer still has the old path
        v_moved: tried(["/Volumes/Tiny/Old/moved.mov"]),
        // read here already
        v_same: tried([at("same.mov")]),
        // read here at a/copy.mov, seen in this look too: b/copy.mov is a second copy
        v_copy: tried([at("a/copy.mov")]),
      },
    });
    m.reportPlaces.mockImplementation(async (_lib: string, r: PlacesReport) => ({ confirmed: r.confirmed.map((c) => c.versionId), refused: [] }));
    m.indexOnMac.mockResolvedValue({ assetId: "a_new" });
    const library = { id: "lib", name: "Tiny Acrobatics", settings: { places } } as unknown as LibrarySummary;
    expect(await lookForNew(library, () => undefined)).toEqual({ added: 1, reconnected: 1 });
    expect(m.reportPlaces).toHaveBeenCalledTimes(1);
    expect(m.reportPlaces).toHaveBeenCalledWith("lib", { device: "mac_1", confirmed: [{ versionId: "v_moved", path: at("moved.mov"), quick: "q-moved.mov" }], gone: [] });
  });

  it("says what it did in one line", () => {
    expect(lookedLine(3, 12)).toBe("Added 3 · reconnected 12");
    expect(lookedLine(0, 2)).toBe("Reconnected 2");
    expect(lookedLine(1, 0)).toBe("Added 1");
    expect(lookedLine(0, 0)).toBe("No new files");
  });
});
