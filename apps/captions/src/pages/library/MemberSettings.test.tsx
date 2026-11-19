// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary } from "@contracts/library";
import { anyFilter } from "./Filters";
import { DownloadsCard, hostedWords, MemberSettings, OwnerDownloads } from "./MemberSettings";
import { savable } from "./Filters";
import { downloadsOf, type OfflineState } from "./offline-state";
import { listAssets } from "@/lib/library";

// A member's Media Library page: the owner's settings read only, Downloads in the Mac app, and the offline list.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const lib = (upload: LibrarySummary["settings"]["upload"], extra: Partial<LibrarySummary["settings"]> = {}): LibrarySummary =>
  ({ id: "lib_1", name: "Tiny Acrobatics", storage: "local", settings: { upload, setupAt: "2026-11-01T00:00:00Z", ...extra } }) as unknown as LibrarySummary;

let host: HTMLDivElement;
let root: Root;
let calls: { url: string; method: string; body?: unknown }[];
let offline: OfflineState;
let serverWork: object;
let storageView: object;

// a folder of one role on one computer (the fields the Folders card reads)
const folder = (role: string, host: string, path: string) => ({ id: `${role}-${path}`, role, name: path, origin: { host, path }, make: false, createdAt: 0 });

function route(url: string, init?: RequestInit): Response {
  if (url === "/api/work/server-work") return Response.json(serverWork);
  if (url === "/api/devices/storage") return Response.json(storageView);
  if (url === "/api/library/offline" && (!init || !init.method)) return Response.json(offline);
  if (url === "/api/library/offline/downloads") {
    const body = JSON.parse(String(init?.body)) as { mode: string; proxies?: boolean; originals?: boolean };
    offline = { ...offline, downloads: { lib_1: body.mode === "all" ? { mode: "all", proxies: body.proxies, originals: body.originals } : { mode: body.mode as "needed" } } };
    return Response.json(offline);
  }
  return Response.json({});
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  document.documentElement.dataset.macDevice = "dev_mac";
  calls = [];
  offline = { versions: [], collections: [], libraries: [], downloads: {} };
  serverWork = { kind: "hosted", place: null, serverName: "Creator Toolset Cloud", workspace: { id: "ws", rendering: true } };
  storageView = { folders: [], here: [], serverDisks: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return route(url, init);
    }),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.macDevice;
  vi.unstubAllGlobals();
});

const show = async (el: React.ReactNode) => {
  await act(async () => root.render(el));
  await act(async () => {});
};
const sw = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const toggle = async (label: string) => act(async () => sw(label).click());

describe("the workspace's settings, read only", () => {
  it("shows the server name, Hosted media in words and this workspace's rendering, with no 'set by'", async () => {
    await show(<MemberSettings library={lib("proxies", { finalsUpload: "all" })} />);
    expect(host.textContent).toContain("Creator Toolset Cloud");
    expect(host.textContent).toContain("Proxies and final exports");
    expect(host.textContent).toContain("Server rendering");
    expect(host.textContent).not.toContain("set by");
  });

  it("says Final exports alone when Upload to server is off and Final exports is on", () => {
    expect(hostedWords({ upload: "none", finalsUpload: "all" } as LibrarySummary["settings"])).toBe("Final exports");
    expect(hostedWords({ upload: "none" } as LibrarySummary["settings"])).toBe("Off");
    expect(hostedWords({ upload: "originals" } as LibrarySummary["settings"])).toBe("Originals");
    expect(hostedWords({ upload: "all" } as LibrarySummary["settings"])).toBe("Originals and proxies");
  });

  it("says the library isn't set up yet, without the owner's sections", async () => {
    await show(<MemberSettings library={lib("all", { setupAt: undefined })} />);
    expect(host.textContent).toContain("This Media Library isn't set up yet.");
  });
});

describe("Downloads", () => {
  it("is shown in the Mac app while Hosted media is on, and hidden in a browser or with Hosted media off", async () => {
    await show(<DownloadsCard library={lib("all")} />);
    expect(sw("Automatic downloads")).not.toBeNull();
    await show(<DownloadsCard library={lib("none")} />);
    expect(host.querySelector('[aria-label="Automatic downloads"]')).toBeNull();
    delete document.documentElement.dataset.macDevice;
    await show(<DownloadsCard library={lib("all")} />);
    expect(host.querySelector('[aria-label="Automatic downloads"]')).toBeNull();
  });

  it("starts on Automatic and off offline; turning offline on turns Automatic on and takes the hosted kinds", async () => {
    await show(<DownloadsCard library={lib("all")} />);
    expect(sw("Automatic downloads").getAttribute("aria-checked")).toBe("true");
    expect(sw("Make available offline").getAttribute("aria-checked")).toBe("false");
    await toggle("Make available offline");
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/library/offline/downloads");
    expect(put.body).toEqual({ library: "lib_1", mode: "all", proxies: true, originals: true });
  });

  it("turning Automatic off turns offline off too (mode none)", async () => {
    offline.downloads = { lib_1: { mode: "all", proxies: true, originals: false } };
    await show(<DownloadsCard library={lib("all")} />);
    await toggle("Automatic downloads");
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ mode: "none", library: "lib_1" });
  });

  it("a kind the workspace doesn't host is off, disabled and says Not hosted; the last kind on can't go off", async () => {
    offline.downloads = { lib_1: { mode: "all", proxies: true } };
    await show(<DownloadsCard library={lib("proxies")} />);
    const originals = sw("Originals");
    expect(originals.disabled).toBe(true);
    expect(host.textContent).toContain("Not hosted");
    expect(sw("Proxies").disabled).toBe(true);
  });

  it("an old 'Keep on this computer' library reads as offline with proxies", () => {
    const s = { ...offline, libraries: ["lib_1"] };
    expect(downloadsOf(s, "lib_1")).toEqual({ mode: "all", proxies: true });
    expect(downloadsOf(offline, "lib_1")).toEqual({ mode: "needed" });
  });
});

describe("Available offline", () => {
  it("the filter narrows to the person's own list, and an empty list is sent as no clip", async () => {
    expect(anyFilter({ offline: true })).toBe(true);
    expect(anyFilter({})).toBe(false);
    await listAssets("lib_1", { versions: ["v1", "v2"] });
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toContain("versions=v1%2Cv2");
    await listAssets("lib_1", { versions: [] });
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toContain("versions=none");
  });
});

describe("Folders on this computer", () => {
  it("shows this computer's Source media folders with Add folder…, and Project files and Final exports as Not set", async () => {
    storageView = { folders: [folder("footage", "dev_mac", "/Volumes/Drive/Footage"), folder("footage", "dev_other", "/Volumes/Other")], here: [], serverDisks: [] };
    await show(<MemberSettings library={lib("all")} />);
    expect(host.textContent).toContain("/Volumes/Drive/Footage");
    expect(host.textContent).not.toContain("/Volumes/Other");
    expect(host.textContent).toContain("Add folder…");
    expect(host.textContent!.split("Not set").length - 1).toBe(2);
  });

  it("shows no Not set before the folder list answers, so a folder never flashes Not set", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    await show(<MemberSettings library={lib("all")} />);
    expect(host.textContent).toContain("Project files");
    expect(host.textContent).not.toContain("Not set");
  });

  it("Set… opens the folder dialog for the role it was pressed on", async () => {
    await show(<MemberSettings library={lib("all")} />);
    const set = [...host.querySelectorAll("button")].find((b) => b.textContent === "Set…")!;
    await act(async () => set.click());
    expect(document.body.textContent).toContain("Projects folder");
  });
});

describe("the owner's Downloads", () => {
  it("is shown on a computer with no Source media folder for the workspace, and not where there is one", async () => {
    await show(<OwnerDownloads library={lib("all")} />);
    expect(sw("Automatic downloads")).not.toBeNull();
    storageView = { folders: [folder("footage", "dev_mac", "/Volumes/Drive/Footage")], here: [], serverDisks: [] };
    // a fresh mount, so the folder list is read again
    await act(async () => root.unmount());
    root = createRoot(host);
    await show(<OwnerDownloads library={lib("all")} />);
    expect(host.querySelector('[aria-label="Automatic downloads"]')).toBeNull();
  });
});

describe("a saved search", () => {
  it("never keeps Available offline, which names this person's list", () => {
    expect(savable({ tags: ["a"], offline: true })).toEqual({ tags: ["a"] });
    expect(savable({ tags: ["a"] })).toEqual({ tags: ["a"] });
  });
});
