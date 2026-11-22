// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary } from "@contracts/library";
import type { PlacesReport } from "@contracts/places";
import { EmptyDrop } from "./EmptyDrop";
import { CantRead, copyAvailable, copyInto, importPlace, lookedLine, lookForNew, sourceRowsHere, useImportQuestion, useWaitingFolders, waitingFolders } from "./Import";

const m = vi.hoisted(() => ({ importScan: vi.fn(), importPrint: vi.fn(), importCopy: vi.fn(), pathOnMac: vi.fn(), checkUpload: vi.fn(), versionPlaces: vi.fn(), reportPlaces: vi.fn(), indexOnMac: vi.fn(), listMediaFolders: vi.fn(), folderGrant: vi.fn(), devices: [{ id: "mac_1", name: "Studio Mac" }] }));
vi.mock("@/lib/thisMac", async (orig) => ({ ...(await orig<typeof import("@/lib/thisMac")>()), importScan: m.importScan, importPrint: m.importPrint, importCopy: m.importCopy, pathOnMac: m.pathOnMac }));
vi.mock("@/lib/library", async (orig) => ({ ...(await orig<typeof import("@/lib/library")>()), checkUpload: m.checkUpload, versionPlaces: m.versionPlaces, reportPlaces: m.reportPlaces }));
vi.mock("@/lib/local-files", async (orig) => ({ ...(await orig<typeof import("@/lib/local-files")>()), listMediaFolders: m.listMediaFolders, folderGrant: m.folderGrant }));
vi.mock("@/lib/providers", async (orig) => ({ ...(await orig<typeof import("@/lib/providers")>()), useProviders: () => ({ data: { devices: m.devices } }) }));
vi.mock("@/lib/onMac", async (orig) => ({ ...(await orig<typeof import("@/lib/onMac")>()), indexOnMac: m.indexOnMac }));

// Adding files asks nothing: the stored answer decides. Copies go under the first Source media row on this computer.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = undefined;
  delete document.documentElement.dataset.macImport;
  delete document.documentElement.dataset.macDevice;
  delete (window as { webkit?: unknown }).webkit;
  vi.unstubAllGlobals();
});

/** This computer's Source media rows, as the storage list has them (another computer's row is left out). */
function storage(rows: { path: string; host?: string; role?: string; workspace?: string; leaveOut?: string[]; reach?: Record<string, { path: string; at: number }> }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ folders: rows.map((r) => ({ id: r.path, role: r.role ?? "footage", workspace: r.workspace, origin: { host: r.host ?? "mac_1", path: r.path }, reach: r.reach ?? {}, ...(r.leaveOut ? { leaveOut: r.leaveOut } : {}) })) }))),
  );
}

describe("where copies go", () => {
  it("the workspace's own Media folder comes before one every workspace uses, whatever the list order", async () => {
    document.documentElement.dataset.macDevice = "mac_1";
    storage([{ path: "/Volumes/Shared/Footage", workspace: "*" }, { path: "/Volumes/Tiny/Footage", workspace: "ws_tiny" }]);
    expect(await sourceRowsHere()).toEqual(["/Volumes/Tiny/Footage", "/Volumes/Shared/Footage"]);
  });

  it("a copy keeps the dropped folder's name under the first Source media row, and a loose file goes in by its own name", () => {
    const inFolder = new File(["x"], "a.mp4");
    Object.defineProperty(inFolder, "webkitRelativePath", { value: "Trip/Day 1/a.mp4" });
    expect(copyInto("~/Movies/Creator Toolset/Tiny/Source media/", inFolder)).toBe("~/Movies/Creator Toolset/Tiny/Source media/Trip/Day 1/a.mp4");
    expect(copyInto("/Volumes/Tiny/Footage", new File(["x"], "b.mp4"))).toBe("/Volumes/Tiny/Footage/b.mp4");
  });

  it("the Source media rows here are the footage rows of this computer, in list order", async () => {
    document.documentElement.dataset.macDevice = "mac_1";
    storage([{ path: "/Volumes/Tiny/Footage" }, { path: "/Volumes/Other/Footage", host: "pc_2" }, { path: "/Volumes/Tiny/Exports", role: "library" }, { path: "/Volumes/Tiny/Footage 2" }]);
    expect(await sourceRowsHere()).toEqual(["/Volumes/Tiny/Footage", "/Volumes/Tiny/Footage 2"]);
  });

  it("no Source media row here means no rows, not a guess", async () => {
    vi.clearAllMocks();
    storage([{ path: "/Volumes/Other/Footage", host: "pc_2" }]);
    expect(await sourceRowsHere()).toEqual([]); // no device id: nothing is read
  });
});

describe("copying", () => {
  it("copying needs the latest Mac app, except a folder the server on this computer copies", () => {
    vi.stubGlobal("webkit", { messageHandlers: { thisMac: { postMessage: async () => ({}) } } });
    expect(copyAvailable("mac")).toBe(false);
    expect(copyAvailable("here", true)).toBe(true);
    document.documentElement.dataset.macImport = "1";
    expect(copyAvailable("mac")).toBe(true);
    expect(copyAvailable("browser")).toBe(false);
  });
});

describe("Look for new files", () => {
  it("adds what is new and reconnects a file the library has at a path this computer doesn't read it from", async () => {
    document.documentElement.dataset.macDevice = "mac_1";
    storage([{ path: "/Volumes/Tiny/Footage" }]);
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
    const library = { id: "lib", name: "Tiny Acrobatics", settings: {} } as unknown as LibrarySummary;
    expect(await lookForNew(library, () => undefined)).toEqual({ added: 1, reconnected: 1, refused: [] });
    expect(m.reportPlaces).toHaveBeenCalledTimes(1);
    expect(m.reportPlaces).toHaveBeenCalledWith("lib", { device: "mac_1", confirmed: [{ versionId: "v_moved", path: at("moved.mov"), quick: "q-moved.mov" }], gone: [] });
  });

  it("reads a folder it may not read through its granted folders inside, reconnects an upload found there, and names the folder", async () => {
    document.documentElement.dataset.macDevice = "mac_1";
    storage([{ path: "/Volumes/Tiny/Footage" }]);
    vi.clearAllMocks();
    const inside = "/Volumes/Tiny/Footage/Day 1";
    m.importScan.mockImplementation(async (p: string) => {
      if (p !== inside) throw new Error("This app may not read that folder. Drop it on the window first.");
      return [{ path: `${inside}/flip.mov`, size: 5, mtime: 0 }];
    });
    m.listMediaFolders.mockResolvedValue([inside, "/Volumes/Tiny/Other"]);
    m.importPrint.mockResolvedValue({ [`${inside}/flip.mov`]: "q-flip" });
    m.checkUpload.mockResolvedValue({ duplicateOf: "a_flip", versionId: "v_flip" });
    // uploaded: the server has no path for it anywhere
    m.versionPlaces.mockResolvedValue({ versions: { v_flip: { tries: [], bytes: 5, quick: "q-flip", proxy: null } } });
    m.reportPlaces.mockImplementation(async (_lib: string, r: PlacesReport) => ({ confirmed: r.confirmed.map((c) => c.versionId), refused: [] }));
    const library = { id: "lib", name: "Tiny Acrobatics", settings: {} } as unknown as LibrarySummary;
    expect(await lookForNew(library, () => undefined)).toEqual({ added: 0, reconnected: 1, refused: ["/Volumes/Tiny/Footage"] });
    expect(m.importScan).toHaveBeenCalledTimes(2); // the folder, then only the granted folder inside it
    expect(m.reportPlaces).toHaveBeenCalledWith("lib", { device: "mac_1", confirmed: [{ versionId: "v_flip", path: `${inside}/flip.mov`, quick: "q-flip" }], gone: [] });
  });

  it("a file in a folder the row leaves out is never fingerprinted, checked, indexed or counted", async () => {
    document.documentElement.dataset.macDevice = "mac_1";
    storage([{ path: "/Volumes/Tiny/Footage", leaveOut: ["- No Share"] }]);
    vi.clearAllMocks();
    const at = (n: string) => `/Volumes/Tiny/Footage/${n}`;
    m.importScan.mockResolvedValue([at("Day 1/a.mov"), at("Day 1/- NO SHARE/x/b.mov")].map((p, i) => ({ path: p, size: i + 1, mtime: 0 })));
    m.importPrint.mockImplementation(async (paths: string[]) => Object.fromEntries(paths.map((p) => [p, `q-${p.split("/").pop()}`])));
    m.checkUpload.mockResolvedValue({});
    m.indexOnMac.mockResolvedValue({ assetId: "a_new" });
    const steps: string[] = [];
    const library = { id: "lib", name: "Tiny Acrobatics", settings: {} } as unknown as LibrarySummary;
    expect(await lookForNew(library, (s) => steps.push(s))).toEqual({ added: 1, reconnected: 0, refused: [] });
    expect(m.importPrint.mock.calls.flatMap((c) => c[0] as string[])).toEqual([at("Day 1/a.mov")]);
    expect(m.checkUpload).toHaveBeenCalledTimes(1);
    expect(m.indexOnMac).toHaveBeenCalledTimes(1);
    expect(steps).toContain("Adding 1 of 1 from Footage");
  });

  it("only this Mac's path of a row counts: another computer's path to it never leaves a file out here", async () => {
    document.documentElement.dataset.macDevice = "mac_1";
    // on pc_2 the row is found a level up, so there "Footage" is a folder inside it
    storage([{ path: "/Volumes/Tiny/Footage", leaveOut: ["Footage"], reach: { pc_2: { path: "/Volumes/Tiny", at: 0 } } }]);
    vi.clearAllMocks();
    m.importScan.mockResolvedValue([{ path: "/Volumes/Tiny/Footage/a.mov", size: 1, mtime: 0 }]);
    m.importPrint.mockImplementation(async (paths: string[]) => Object.fromEntries(paths.map((p) => [p, "q-a"])));
    m.checkUpload.mockResolvedValue({});
    m.indexOnMac.mockResolvedValue({ assetId: "a_new" });
    const library = { id: "lib", name: "Tiny Acrobatics", settings: {} } as unknown as LibrarySummary;
    expect(await lookForNew(library, () => undefined)).toEqual({ added: 1, reconnected: 0, refused: [] });
  });

  it("a granted folder that can't be read says why, as before", async () => {
    document.documentElement.dataset.macDevice = "mac_1";
    storage([{ path: "/Volumes/Tiny/Footage" }]);
    vi.clearAllMocks();
    m.importScan.mockRejectedValue(new Error("That folder's disk isn't connected."));
    m.listMediaFolders.mockResolvedValue(["/Volumes/Tiny"]);
    const library = { id: "lib", name: "Tiny Acrobatics", settings: {} } as unknown as LibrarySummary;
    await expect(lookForNew(library, () => undefined)).rejects.toThrow("disk isn't connected");
  });

  it("says what it did in one line", () => {
    expect(lookedLine(3, 12)).toBe("Added 3 · reconnected 12");
    expect(lookedLine(0, 2)).toBe("Reconnected 2");
    expect(lookedLine(1, 0)).toBe("Added 1");
    expect(lookedLine(0, 0)).toBe("No new files");
  });
});

describe("Folders this Mac may not read yet", () => {
  const folder = (id: string, host: string, folderState?: string, role = "footage") => ({ id, role, origin: { host, path: `/Volumes/Tiny/${id}` }, folderState }) as never;
  const inMacApp = () => ((window as { webkit?: unknown }).webkit = { messageHandlers: { thisMac: { postMessage: vi.fn() } } });

  it("are this Mac's Media folders waiting for its OK; in a browser every computer's", () => {
    const view = { folders: [folder("Media", "mac_1", "needs_ok"), folder("Done", "mac_1", "ok"), folder("Other", "pc_2", "needs_ok"), folder("New", "mac_1"), folder("Projects", "mac_1", "needs_ok", "projects"), { ...(folder("Gone", "mac_9", "needs_ok") as object), missing: true } as never] };
    expect(waitingFolders(view, "mac_1").map((f) => f.id)).toEqual(["Media"]);
    expect(waitingFolders(view, undefined)).toEqual([]);
    expect(waitingFolders(view, undefined, true).map((f) => f.id)).toEqual(["Media", "Other"]);
  });

  /** The empty Media Library as the page draws it: the waiting folders (read from the server) and the drop box. */
  async function emptyLibrary(state: string) {
    vi.clearAllMocks();
    document.documentElement.dataset.macDevice = "mac_1";
    inMacApp();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ folders: [folder("Media", "mac_1", state)] }))));
    const Page = () => <EmptyDrop canAdd onChoose={() => undefined} waiting={useWaitingFolders("lib_1")} />;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Page />));
  }

  it("fill the middle of an empty Media Library with Allow on this Mac, allowed only on the press", async () => {
    await emptyLibrary("needs_ok");
    m.folderGrant.mockResolvedValue(true);
    expect(host!.textContent).toContain("Creator Toolset can't read Media yet; once allowed, its files are added to the Media Library.");
    expect(host!.textContent).not.toContain("Drop media here");
    expect(m.folderGrant).not.toHaveBeenCalled();
    await act(async () => host!.querySelector("button")!.click());
    expect(m.folderGrant).toHaveBeenCalledWith("/Volumes/Tiny/Media", "Media");
    expect(host!.textContent).toContain("Drop media here"); // allowed: the notice goes, the library fills as the Mac reads it
  });

  it("leave the empty Media Library as the drop box when the folder is read", async () => {
    await emptyLibrary("ok");
    expect(host!.textContent).toContain("Drop media here");
    expect(host!.textContent).not.toContain("can't read");
  });

  it("in a browser name the Mac that has to allow them, with no button", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ folders: [folder("Media", "mac_1", "needs_ok")] }))));
    const Bar = () => <CantRead {...useWaitingFolders()} />;
    host = document.createElement("div");
    root = createRoot(host);
    await act(async () => root!.render(<Bar />));
    expect(host.textContent).toBe("Creator Toolset can't read Media yet; open the Mac app on Studio Mac and press Allow on this Mac to add its files to the Media Library.");
    expect(host.querySelector("button")).toBeNull();
  });
});

describe("the import rule, with no question", () => {
  type Answer = ReturnType<typeof useImportQuestion>["answer"];
  async function answerWith(look: { from: "mac" | "browser"; paths?: Map<File, string> }, files: File[], onError = vi.fn()) {
    let answer!: Answer;
    const Host = () => {
      answer = useImportQuestion({ serverHere: false, onError }).answer;
      return null;
    };
    host = document.createElement("div");
    root = createRoot(host);
    await act(async () => root!.render(<Host />));
    return { result: await answer(look as never, files), onError };
  }
  const day = new Date().toISOString().slice(0, 10);
  const file = new File(["x"], "a.mp4");
  const mac = { from: "mac" as const, paths: new Map([[file, "/Users/tiny/Downloads/a.mp4"]]) };
  // a dropped folder's file: its webkitRelativePath is the folder's name and the file's path in it
  const inFolder = Object.defineProperty(new File(["x"], "b.mp4"), "webkitRelativePath", { value: "Shoot/b.mp4" });
  const folderMac = { from: "mac" as const, paths: new Map([[inFolder, "/Users/tiny/Downloads/Shoot/b.mp4"]]) };
  const inMedia = new File(["x"], "c.mp4");
  const mediaMac = { from: "mac" as const, paths: new Map([[inMedia, "/Volumes/Tiny/Footage/Shoot 2/c.mp4"]]) };

  beforeEach(() => {
    document.documentElement.dataset.macImport = "1";
    document.documentElement.dataset.macDevice = "mac_1";
  });

  it("copies a file from outside once into the first Media folder's Imports/, a folder's file with its folder's name", async () => {
    storage([{ path: "/Volumes/Tiny/Footage" }, { path: "/Volumes/Tiny/Footage 2" }]);
    const both = { from: "mac" as const, paths: new Map([...mac.paths, ...folderMac.paths]) };
    expect((await answerWith(both, [file, inFolder])).result).toEqual(
      new Map([
        [file, `/Volumes/Tiny/Footage/Imports/${day}/a.mp4`],
        [inFolder, `/Volumes/Tiny/Footage/Imports/${day}/Shoot/b.mp4`],
      ]),
    );
  });

  it("copies nothing of a file inside a Media folder (any depth): it is indexed where it is", async () => {
    storage([{ path: "/Volumes/Tiny/Footage" }]);
    expect((await answerWith(mediaMac, [inMedia])).result).toEqual(new Map());
    const both = { from: "mac" as const, paths: new Map([...mac.paths, ...mediaMac.paths]) };
    expect((await answerWith(both, [file, inMedia])).result).toEqual(new Map([[file, `/Volumes/Tiny/Footage/Imports/${day}/a.mp4`]]));
  });

  it("a browser's files copy nothing", async () => {
    storage([{ path: "/Volumes/Tiny/Footage" }]);
    expect((await answerWith({ from: "browser" }, [file])).result).toEqual(new Map());
  });

  it("an older Mac app can't copy: the file is indexed where it is", async () => {
    delete document.documentElement.dataset.macImport;
    storage([{ path: "/Volumes/Tiny/Footage" }]);
    expect((await answerWith(mac, [file])).result).toEqual(new Map());
  });

  it("with no Media folder here, a file from outside is refused and the line says where to add one", async () => {
    storage([]);
    const { result, onError } = await answerWith(mac, [file]);
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith("Add a Media folder in Settings → Folders");
  });
});

describe("an edit's footage from this Mac (importPlace)", () => {
  const file = new File(["x"], "a.mp4");
  beforeEach(() => {
    document.documentElement.dataset.macImport = "1";
    document.documentElement.dataset.macDevice = "mac_1";
    storage([{ path: "/Volumes/Tiny/Footage" }]);
    m.pathOnMac.mockResolvedValue("/Users/tiny/Downloads/a.mp4");
    m.checkUpload.mockResolvedValue({});
  });

  it("copies a file from outside into Imports/<edit name>", async () => {
    m.importCopy.mockResolvedValue({ copied: [{ from: "/Users/tiny/Downloads/a.mp4", to: "/Volumes/Tiny/Footage/Imports/Summer reel/a.mp4" }], failed: [] });
    expect(await importPlace("lib", file, "Summer reel")).toBe("/Volumes/Tiny/Footage/Imports/Summer reel/a.mp4");
    expect(m.importCopy.mock.calls.at(-1)![1]).toEqual([{ from: "/Users/tiny/Downloads/a.mp4", to: "/Volumes/Tiny/Footage/Imports/Summer reel/a.mp4" }]);
  });

  it("a Mac app that doesn't copy into that Imports/ yet: the file is used where it is, never refused", async () => {
    m.importCopy.mockResolvedValue({ copied: [], failed: [{ from: "/Users/tiny/Downloads/a.mp4", error: "Not a folder this app copies into." }] });
    expect(await importPlace("lib", file, "Summer reel")).toBe("/Users/tiny/Downloads/a.mp4");
  });

  it("its drive away: the copy fails and says so", async () => {
    m.importCopy.mockResolvedValue({ copied: [], failed: [{ from: "/Users/tiny/Downloads/a.mp4", error: "Footage isn't connected." }] });
    await expect(importPlace("lib", file, "Summer reel")).rejects.toThrow("Footage isn't connected.");
  });
});
