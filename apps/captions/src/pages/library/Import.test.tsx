// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyAvailable, copyPath, ImportCards, importAsk, NEEDS_MAC, placeOfFile } from "./Import";

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
    act(() => root!.render(<ImportCards legend="How do you want to add your files?" value="in-place" onChange={() => {}} copy={{ to: null, off: NEEDS_MAC }} />));
    const copy = [...host.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Copy them into the library"))!;
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
