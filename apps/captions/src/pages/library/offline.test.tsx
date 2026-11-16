// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetCard } from "@contracts/library";
import type { LibraryFilters } from "@/lib/library";
import { AssetRow, AssetTile } from "./ClipCards";
import { OfflineSwitch, offlineState } from "./ClipPanel";
import { HereFilter } from "./Filters";

// The Mac app's own computer in the Media Library: the mark on a card, the On this computer filter, Available offline.

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

describe("Available offline", () => {
  it("a clip's switch reads the person's list and sets it; a clip in a folder kept offline is on with it", async () => {
    let list = { versions: [] as string[], collections: [] as string[] };
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const b = JSON.parse(String(init.body)) as { version: string; on: boolean };
          sent.push(b);
          list = { ...list, versions: b.on ? [b.version] : [] };
        }
        return new Response(JSON.stringify(list), { headers: { "content-type": "application/json" } });
      }),
    );
    await act(async () => root.render(<OfflineSwitch versionId="v1" folders={[]} onError={() => {}} />));
    const sw = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(host.textContent).toContain("Available offline");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    await act(async () => sw().click());
    expect(sent).toEqual([{ version: "v1", on: true }]);
    expect(sw().getAttribute("aria-checked")).toBe("true");

    expect(offlineState({ versions: [], collections: ["f1"] }, "v1", [{ id: "f1", name: "Trips" }])).toEqual({ on: true, folder: "Trips" });
    expect(offlineState({ versions: ["v1"], collections: [] }, "v1", [{ id: "f1", name: "Trips" }])).toEqual({ on: true });
  });

  it("is not there outside the Mac app", async () => {
    delete document.documentElement.dataset.macDevice;
    vi.stubGlobal("fetch", vi.fn());
    await act(async () => root.render(<OfflineSwitch versionId="v1" folders={[]} onError={() => {}} />));
    expect(host.querySelector('[role="switch"]')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
