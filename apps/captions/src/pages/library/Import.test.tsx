// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary } from "@contracts/library";
import type { PlacesReport } from "@contracts/places";
import { copyAvailable, copyInto, FoldersToAllow, lookedLine, lookForNew, sourceRowsHere, useImportQuestion, waitingFolders } from "./Import";

const m = vi.hoisted(() => ({ importScan: vi.fn(), importPrint: vi.fn(), checkUpload: vi.fn(), versionPlaces: vi.fn(), reportPlaces: vi.fn(), indexOnMac: vi.fn(), listMediaFolders: vi.fn(), folderGrant: vi.fn() }));
vi.mock("@/lib/thisMac", async (orig) => ({ ...(await orig<typeof import("@/lib/thisMac")>()), importScan: m.importScan, importPrint: m.importPrint }));
vi.mock("@/lib/library", async (orig) => ({ ...(await orig<typeof import("@/lib/library")>()), checkUpload: m.checkUpload, versionPlaces: m.versionPlaces, reportPlaces: m.reportPlaces }));
vi.mock("@/lib/local-files", async (orig) => ({ ...(await orig<typeof import("@/lib/local-files")>()), listMediaFolders: m.listMediaFolders, folderGrant: m.folderGrant }));
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
  vi.unstubAllGlobals();
});

/** This computer's Source media rows, as the storage list has them (another computer's row is left out). */
function storage(rows: { path: string; host?: string; role?: string }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ folders: rows.map((r) => ({ id: r.path, role: r.role ?? "footage", origin: { host: r.host ?? "mac_1", path: r.path } })) }))),
  );
}

describe("where copies go", () => {
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
  const folder = (id: string, host: string, folderState?: string) => ({ id, origin: { host, path: `/Volumes/Tiny/${id}` }, folderState }) as never;

  it("are this Mac's Settings → Folders folders waiting for its OK", () => {
    const view = { folders: [folder("Media", "mac_1", "needs_ok"), folder("Done", "mac_1", "ok"), folder("Other", "pc_2", "needs_ok"), folder("New", "mac_1")] };
    expect(waitingFolders(view, "mac_1").map((f) => f.id)).toEqual(["Media"]);
    expect(waitingFolders(view, undefined)).toEqual([]);
  });

  it("show one line on the Library page and are allowed only on the press", async () => {
    vi.clearAllMocks();
    document.documentElement.dataset.macDevice = "mac_1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ folders: [folder("Media", "mac_1", "needs_ok")] }))));
    m.folderGrant.mockResolvedValue(true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<FoldersToAllow />));
    expect(host.textContent).toContain("Creator Toolset can't read Media");
    expect(m.folderGrant).not.toHaveBeenCalled();
    await act(async () => host!.querySelector("button")!.click());
    expect(m.folderGrant).toHaveBeenCalledWith("/Volumes/Tiny/Media", "Media");
    expect(host.textContent).toBe("");
  });
});

describe("the stored answer, with no question", () => {
  type Answer = ReturnType<typeof useImportQuestion>["answer"];
  async function answerWith(library: unknown, look: { from: "mac" | "browser"; paths?: Map<File, string> }, files: File[], onError = vi.fn()) {
    let answer!: Answer;
    const Host = () => {
      answer = useImportQuestion({ library: library as LibrarySummary, serverHere: false, onError }).answer;
      return null;
    };
    host = document.createElement("div");
    root = createRoot(host);
    await act(async () => root!.render(<Host />));
    return { result: await answer(look as never, files), onError };
  }
  const file = new File(["x"], "a.mp4");
  const mac = { from: "mac" as const, paths: new Map([[file, "/Users/tiny/Downloads/a.mp4"]]) };

  it("copy puts each file under the first Source media row here", async () => {
    document.documentElement.dataset.macImport = "1";
    document.documentElement.dataset.macDevice = "mac_1";
    storage([{ path: "/Volumes/Tiny/Footage" }, { path: "/Volumes/Tiny/Footage 2" }]);
    const { result } = await answerWith({ id: "lib", name: "Tiny", settings: { importMode: "copy" } }, mac, [file]);
    expect(result).toEqual(new Map([[file, "/Volumes/Tiny/Footage/a.mp4"]]));
  });

  it("in place, unset, and a browser copy nothing", async () => {
    document.documentElement.dataset.macImport = "1";
    document.documentElement.dataset.macDevice = "mac_1";
    storage([{ path: "/Volumes/Tiny/Footage" }]);
    expect((await answerWith({ id: "lib", name: "Tiny", settings: { importMode: "in-place" } }, mac, [file])).result).toEqual(new Map());
    expect((await answerWith({ id: "lib", name: "Tiny", settings: {} }, mac, [file])).result).toEqual(new Map());
    expect((await answerWith({ id: "lib", name: "Tiny", settings: { importMode: "copy" } }, { from: "browser" }, [file])).result).toEqual(new Map());
  });

  it("copy with no Source media row here refuses the add and says why", async () => {
    document.documentElement.dataset.macImport = "1";
    document.documentElement.dataset.macDevice = "mac_1";
    storage([]);
    const { result, onError } = await answerWith({ id: "lib", name: "Tiny", settings: { importMode: "copy" } }, mac, [file]);
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith("Add a Source media folder on this computer first");
  });
});
