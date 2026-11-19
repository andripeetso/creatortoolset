// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary } from "@contracts/library";
import { useLibraryDrop } from "./LibraryDrop";

const m = vi.hoisted(() => ({ droppedFiles: vi.fn() }));
vi.mock("@/components/assistant/draft", () => ({ droppedFiles: m.droppedFiles }));
vi.mock("@/components/LibraryProcessing", () => ({ useBigFolder: () => ({ check: (_p: string, add: () => unknown) => add(), after: (fn: () => void) => fn(), dialog: null }) }));
vi.mock("@/lib/library", () => ({ getWatch: async () => ({}) }));

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

/** Drops `d` on the page with a library's stored answer; returns the requests made and what was added. */
async function drop(library: unknown, d: { files: File[]; folders: string[] }) {
  m.droppedFiles.mockResolvedValue({ folder: d.folders.length > 0, folders: d.folders, files: d.files, paths: new Map() });
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  document.documentElement.dataset.macDevice = "mac_1";
  const addFiles = vi.fn();
  let props!: ReturnType<typeof useLibraryDrop>["props"];
  const Host = () => {
    props = useLibraryDrop({ library: library as LibrarySummary, readsFolders: true, offer: false, answerOffer: async () => {}, addFiles, onWatch: () => {}, onError: vi.fn() }).props;
    return null;
  };
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root!.render(<Host />));
  await act(async () => {
    props.onDrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: { length: 1 } } } as never);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { fetchMock, addFiles };
}

describe("a drop follows the stored answer, with no question", () => {
  const lib = (importMode?: string) => ({ id: "lib_1", settings: importMode ? { importMode } : {} });

  it("in place: a dropped folder becomes a Source media row on this computer, and its files are indexed where they are", async () => {
    const { fetchMock, addFiles } = await drop(lib("in-place"), { folders: ["/Volumes/Tiny/Shoot"], files: [inFolder("b.mp4", "Shoot/b.mp4")] });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/devices/storage/folders"]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ role: "footage", host: "mac_1", path: "/Volumes/Tiny/Shoot" });
    expect(addFiles).not.toHaveBeenCalled();
  });

  it("copy: a dropped folder is not a row; its media files go to addFiles, and other files from it do not", async () => {
    const b = inFolder("b.mp4", "Shoot/b.mp4");
    const { fetchMock, addFiles } = await drop(lib("copy"), { folders: ["/Volumes/Tiny/Shoot"], files: [b, inFolder(".DS_Store", "Shoot/.DS_Store")] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(addFiles).toHaveBeenCalledWith([b], undefined);
  });

  it("a loose file dropped by itself goes to addFiles as it is, in place or unset", async () => {
    const c = new File(["x"], "c.mov");
    expect((await drop(lib("in-place"), { folders: [], files: [c] })).addFiles).toHaveBeenCalledWith([c], undefined);
    expect((await drop(lib(), { folders: [], files: [c] })).addFiles).toHaveBeenCalledWith([c], undefined);
  });
});
