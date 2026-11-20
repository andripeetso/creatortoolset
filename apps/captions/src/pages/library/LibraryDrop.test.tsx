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
async function drop(library: unknown, d: { files: File[]; folders: string[] }) {
  m.droppedFiles.mockResolvedValue({ folder: d.folders.length > 0, folders: d.folders, files: d.files, paths: new Map() });
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  document.documentElement.dataset.macDevice = "mac_1";
  const addFiles = vi.fn();
  let props!: ReturnType<typeof useLibraryDrop>["props"];
  const Host = () => {
    props = useLibraryDrop({ library: library as LibrarySummary, readsFolders: true, addFiles, onError: vi.fn() }).props;
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

describe("a drop goes to the import rule, with no question", () => {
  const lib = { id: "lib_1", settings: {} };

  it("a dropped folder is never made a row: its media files go to addFiles (Import.tsx decides in place or Imports/), other files from it do not", async () => {
    const b = inFolder("b.mp4", "Shoot/b.mp4");
    const { fetchMock, addFiles } = await drop(lib, { folders: ["/Volumes/Tiny/Shoot"], files: [b, inFolder(".DS_Store", "Shoot/.DS_Store")] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(addFiles).toHaveBeenCalledWith([b], undefined);
  });

  it("a loose file dropped by itself goes to addFiles as it is", async () => {
    const c = new File(["x"], "c.mov");
    expect((await drop(lib, { folders: [], files: [c] })).addFiles).toHaveBeenCalledWith([c], undefined);
  });
});
