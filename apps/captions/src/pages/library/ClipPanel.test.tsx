// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetCard, AssetDetail } from "@contracts/library";
import type { PlaceCheck } from "@contracts/places";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useAuth } from "@/lib/auth";
import { ClipPanel } from "./ClipPanel";

// The clip panel's File row and Location menu (docs/media-library-proxies-prd.md R2, L4 to L6): a Tiny Acrobatics clip on a
// server elsewhere, opened in the Mac app on the computer that blurred it. One chain: Original → Blurred → Proxy.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGINAL = "/Volumes/footage/2025/beach.mov";
const BLURRED = "/Volumes/footage/Imports/Blurred/beach.mp4";
const PROXY = "/Volumes/Cache/studio/tinyacrobatics/v2.mp4";

const card: AssetCard = {
  id: "a1", libraryId: "lib", kind: "video", title: "Beach run", versionId: "v2", versionN: 2, tags: [], aiTags: [], state: "ready",
  width: 3840, height: 2160, fps: 50, placeWord: { word: "here" }, proxy: { w: 1280, h: 720, cached: true },
};
const detail = {
  ...card,
  versions: [
    { id: "v2", n: 2, bytes: 10, createdAt: 0, createdBy: "tinyacrobatics", state: "ready", blurred: true, of: "v1" },
    { id: "v1", n: 1, bytes: 10, createdAt: 0, createdBy: "tinyacrobatics", state: "ready", path: ORIGINAL },
  ],
  collections: [],
  jobs: [],
  sourcePath: BLURRED,
} as unknown as AssetDetail;

const server = vi.hoisted(() => ({ detail: null as unknown }));
vi.mock("@/lib/library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/library")>()),
  getAsset: async () => server.detail,
  getWhere: async () => ({ versions: {} }),
  listTags: async () => [],
  listLibraries: async () => [],
  relatedAssets: async () => [],
  alikeShots: async () => [],
  useLibraryChanges: () => {},
}));

/** what the Mac app says of each version: the blurred copy and its original here, and the proxy it keeps */
let mac: Record<string, PlaceCheck>;
let asks: string[];
let copies: string[];
let errors: string[];
let host: HTMLDivElement;
let r: Root;

beforeEach(() => {
  server.detail = detail;
  mac = {
    v2: { state: "here", path: BLURRED, url: "ctlocal://media/blurred", cached: "ctlocal://media/proxy", proxyPath: PROXY },
    v1: { state: "here", path: ORIGINAL, url: "ctlocal://media/original" },
  };
  asks = [];
  copies = [];
  errors = [];
  useAuth.setState({ kind: "server" }); // a server others open: the menu copies the clip's link too
  vi.stubGlobal("location", { hostname: "studio.example.com", origin: "https://studio.example.com" });
  vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => ({}) }));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void copies.push(t) } });
  document.documentElement.dataset.macDevice = "dev_mine";
  document.documentElement.dataset.macReveal = "3";
  document.documentElement.dataset.macPlaces = "1";
  const postMessage = async (m: string) => {
    if (m.startsWith("places:check:")) {
      const { versions } = JSON.parse(m.slice("places:check:".length)) as { versions: string[] };
      return { versions: Object.fromEntries(versions.filter((v) => mac[v]).map((v) => [v, mac[v]])) };
    }
    if (m.startsWith("reveal:")) asks.push(m.slice("reveal:".length));
    return { ok: true };
  };
  (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { thisMac: { postMessage } } };
  host = document.body.appendChild(document.createElement("div"));
  r = createRoot(host);
});
afterEach(async () => {
  await act(async () => r.unmount());
  document.body.innerHTML = "";
  delete (window as unknown as { webkit?: unknown }).webkit;
  for (const k of ["macDevice", "macReveal", "macPlaces"]) delete document.documentElement.dataset[k];
  vi.unstubAllGlobals();
  useAuth.setState({ kind: "mac" });
});

async function open(inTrash = false) {
  await act(async () =>
    r.render(
      // the panel is drawn in the clip's window (ClipView): its title needs one around it
      <MemoryRouter>
        <Sheet open>
          <SheetContent>
            <ClipPanel libraryId="lib" asset={card} startAt={0} inTrash={inTrash} moveTo={[]} onTrash={() => {}} onMove={async () => {}} onSaved={() => {}} onError={(e) => errors.push(e)} />
          </SheetContent>
        </Sheet>
      </MemoryRouter>,
    ),
  );
  // the player's skin is its own chunk, and the detail and the Mac app's answer arrive after the first draw
  await act(async () => void (await import("./SkinPlayer")));
  await act(async () => {});
}
const row = (label: string) => [...document.querySelectorAll("dt")].find((d) => d.textContent === label)?.nextElementSibling as HTMLElement | undefined;
const fileRow = () => [...(row("File")?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
const pickFile = (name: string) => act(async () => [...row("File")!.querySelectorAll("button")].find((b) => b.textContent === name)!.click());
// the Location menu's own items (the player's skin has menus too)
const items = () => [...document.querySelectorAll<HTMLElement>('[data-radix-menu-content] [role="menuitem"]')];
async function menu() {
  await act(async () => void row("Location")!.querySelector("button")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })));
  return items().map((i) => i.textContent);
}
/** opens the Location menu and presses one item (the menu closes on a press) */
async function press(name: string) {
  await menu();
  await act(async () => items().find((i) => i.textContent === name)!.click());
  await act(async () => {});
}

describe("the Location menu", () => {
  it("shows and copies each file on this computer, in the chain's order", async () => {
    await open();
    expect(await menu()).toEqual(["Show original in Finder", "Show blurred in Finder", "Show proxy in Finder", "Copy original path", "Copy blurred path", "Copy proxy path", "Copy link"]);
    await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    // each Show names its own file to the Mac app: the original by its version, the blurred copy as the clip, the proxy as the proxy
    for (const name of ["Show original in Finder", "Show blurred in Finder", "Show proxy in Finder"]) await press(name);
    expect(asks.map((a) => JSON.parse(a))).toEqual([{ library: "lib", asset: "a1", version: "v1" }, { library: "lib", asset: "a1" }, { proxy: "v2" }]);

    for (const name of ["Copy original path", "Copy blurred path", "Copy proxy path", "Copy link"]) await press(name);
    expect(copies).toEqual([ORIGINAL, BLURRED, PROXY, "https://studio.example.com/library?clip=a1&library=lib"]);
    expect(errors).toEqual([]);
  });

  it("has no proxy items when the Mac app names no path for the proxy (an older app), and the proxy still plays", async () => {
    mac.v2 = { state: "here", path: BLURRED, url: "ctlocal://media/blurred", cached: "ctlocal://media/proxy" };
    await open();
    expect(await menu()).toEqual(["Show original in Finder", "Show blurred in Finder", "Copy original path", "Copy blurred path", "Copy link"]);
    expect(fileRow()).toEqual(["Original", "Blurred", "Proxy"]);
  });

  it("says Could not copy with no clipboard (plain http) and when the browser refuses", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    await open();
    await press("Copy blurred path");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => Promise.reject(new Error("denied")) } });
    await press("Copy blurred path");
    expect(errors).toEqual(["Could not copy", "Could not copy"]);
  });

  it("is there for a clip in the trash", async () => {
    await open(true);
    expect(await menu()).toContain("Copy blurred path");
  });
});

describe("the File row", () => {
  const playing = () => document.querySelector("video")?.getAttribute("src");

  it("lists the clip's files in the chain's order; the pick plays, and Size and Location describe it", async () => {
    await open();
    expect(fileRow()).toEqual(["Original", "Blurred", "Proxy"]);
    expect(playing()).toBe("ctlocal://media/blurred");
    expect(row("Size")?.textContent).toBe("3840×2160");

    await pickFile("Proxy");
    await act(async () => {});
    expect(playing()).toBe("ctlocal://media/proxy");
    expect(row("Size")?.textContent).toBe("1280×720");
    expect(row("Frame rate")?.textContent).toBe("50 fps");
    expect(row("Location")?.textContent).toBe("On this computer");

    await pickFile("Original");
    await act(async () => {});
    expect(playing()).toBe("ctlocal://media/original");
    expect(row("Size")?.textContent).toBe("3840×2160");
  });

  it("offers no Proxy for a clip with none, and no row for a clip with one file", async () => {
    server.detail = { ...detail, proxy: undefined };
    mac.v2 = { state: "here", path: BLURRED, url: "ctlocal://media/blurred" };
    await open();
    expect(fileRow()).toEqual(["Original", "Blurred"]);

    await act(async () => r.unmount());
    r = createRoot(host);
    delete mac.v1;
    await open();
    expect(row("File")).toBeUndefined();
  });
});
