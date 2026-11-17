// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetCard } from "@contracts/library";
import type { LibraryFilters } from "@/lib/library";
import { AssetRow, AssetTile } from "./ClipCards";
import { HereFilter } from "./Filters";

// The Mac app's own computer in the Media Library: the mark on a card, the On this computer filter.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card: AssetCard = { id: "a1", libraryId: "lib", kind: "video", title: "Beach run", versionId: "v1", versionN: 1, tags: [], aiTags: [], state: "ready" };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  document.documentElement.dataset.macDevice = "dev_mac";
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.macDevice;
  vi.unstubAllGlobals();
});
const show = (el: React.ReactNode) => act(() => root.render(el));
const mark = () => host.querySelector('[aria-label="On this computer"]');

describe("the mark on a card", () => {
  it("shows on a clip on this computer, in the grid and in the list, and nowhere else", () => {
    show(<AssetTile asset={{ ...card, here: true }} onOpen={() => {}} />);
    expect(mark()?.getAttribute("title")).toBe("On this computer");
    show(<AssetRow asset={{ ...card, here: true }} onOpen={() => {}} />);
    expect(mark()).not.toBeNull();
    show(<AssetTile asset={card} onOpen={() => {}} />);
    expect(mark()).toBeNull();
  });
});

describe("On this computer", () => {
  it("narrows to the clips here, a second click lets go; a browser has no computer of its own", () => {
    let value: LibraryFilters = {};
    const render = () => show(<HereFilter value={value} onChange={(here) => (value = { ...value, here })} />);
    render();
    const pill = () => host.querySelector("button")!;
    expect(pill().textContent).toBe("On this computer");
    expect(pill().getAttribute("aria-pressed")).toBe("false");
    act(() => pill().click());
    expect(value.here).toBe(true);
    render();
    expect(pill().getAttribute("aria-pressed")).toBe("true");
    act(() => pill().click());
    expect(value.here).toBeUndefined();
    delete document.documentElement.dataset.macDevice;
    render();
    expect(host.querySelector("button")).toBeNull();
  });
});
