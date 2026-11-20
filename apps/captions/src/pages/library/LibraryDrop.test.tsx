// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary } from "@contracts/library";
import { useLibraryDrop } from "./LibraryDrop";

const m = vi.hoisted(() => ({ droppedFiles: vi.fn() }));
vi.mock("@/components/assistant/draft", () => ({ droppedFiles: m.droppedFiles }));
// replaced (CEO 11-19: organize offer dropped; no big-folder dialog): no useBigFolder to stand in for, no offer to pass

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = undefined;
  delete document.documentElement.dataset.macDevice;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** A file of a dropped folder: its webkitRelativePath is the folder's name and the file's path in it. */
const inFolder = (name: string, rel: string) => Object.defineProperty(new File(["x"], name), "webkitRelativePath", { value: rel });

/** Drops `d` on the page; returns the requests made and what was added. */
async function drop(library: unknown, d: { files: File[]; folders: string[] }, storage: { own: string[]; all: string[] } = { own: [], all: [] }) {
  m.droppedFiles.mockResolvedValue({ folder: d.folders.length > 0, folders: d.folders, files: d.files, paths: new Map() });
  // Settings → Folders: this workspace's Media folders, and with ?all=1 every workspace's, all on this Mac
  const rows = (paths: string[]) => JSON.stringify({ folders: paths.map((path) => ({ id: path, role: "footage", origin: { host: "mac_1", path } })) });
  const fetchMock = vi.fn(async (url: string) => new Response(url.includes("all=1") ? rows(storage.all) : rows(storage.own), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  document.documentElement.dataset.macDevice = "mac_1";
  const addFiles = vi.fn();
  const onError = vi.fn();
  let props!: ReturnType<typeof useLibraryDrop>["props"];
  const Host = () => {
    props = useLibraryDrop({ library: library as LibrarySummary, readsFolders: true, addFiles, onError }).props;
    return null;
  };
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root!.render(<Host />));
  await act(async () => {
    props.onDrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: { length: 1 } } } as never);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { fetchMock, addFiles, onError };
}

describe("a drop goes to the import rule, with no question", () => {
  const lib = { id: "lib_1", settings: {} };

  it("a dropped folder is never made a row: its media files go to addFiles (Import.tsx decides in place or Imports/), other files from it do not", async () => {
    const b = inFolder("b.mp4", "Shoot/b.mp4");
    const { fetchMock, addFiles } = await drop(lib, { folders: ["/Volumes/Tiny/Shoot"], files: [b, inFolder(".DS_Store", "Shoot/.DS_Store")] });
    expect((fetchMock.mock.calls as unknown as [string][]).every(([url]) => url.startsWith("/api/devices/storage"))).toBe(true);   // only read, never a row
    expect(addFiles).toHaveBeenCalledWith([b], undefined);
  });

  it("a folder holding another workspace's Media folder is refused with the AI Editor's line, and nothing of it goes in", async () => {
    const b = inFolder("clip.mov", "Creator Toolset/Other/Media/clip.mov");
    const storage = { own: ["/Users/tiny/Movies/Creator Toolset/Tiny/Media"], all: ["/Users/tiny/Movies/Creator Toolset/Tiny/Media", "/Users/tiny/Movies/Creator Toolset/Other/Media"] };
    const { addFiles, onError } = await drop(lib, { folders: ["/Users/tiny/Movies/Creator Toolset"], files: [b] }, storage);
    expect(addFiles).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("/Users/tiny/Movies/Creator Toolset holds the Media folder /Users/tiny/Movies/Creator Toolset/Other/Media: drop the folder with the footage itself");
  });

  it("this workspace's own Media folder dropped goes in (indexed where it is)", async () => {
    const b = inFolder("a.mov", "Media/a.mov");
    const storage = { own: ["/Users/tiny/Movies/Creator Toolset/Tiny/Media"], all: ["/Users/tiny/Movies/Creator Toolset/Tiny/Media", "/Users/tiny/Movies/Creator Toolset/Other/Media"] };
    const { addFiles, onError } = await drop(lib, { folders: ["/Users/tiny/Movies/Creator Toolset/Tiny/Media"], files: [b] }, storage);
    expect(onError).not.toHaveBeenCalled();
    expect(addFiles).toHaveBeenCalledWith([b], undefined);
  });

  it("a loose file dropped by itself goes to addFiles as it is", async () => {
    const c = new File(["x"], "c.mov");
    expect((await drop(lib, { folders: [], files: [c] })).addFiles).toHaveBeenCalledWith([c], undefined);
  });
});
