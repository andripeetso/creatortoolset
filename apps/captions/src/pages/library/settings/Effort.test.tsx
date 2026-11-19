// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIBRARY_WORDS, type LibrarySettings, type LibrarySummary } from "@contracts/library";
import { clearLocalCache } from "@/lib/local-cache";
import { EffortCost } from "./Effort";
import { OwnerFolders } from "./OwnerFolders";

// The Effort row's "About $N" (UNIFIED-PRD §3.1, SCREENS-COPY §1): the cost of the footage not analyzed yet, from
// /estimate. The owner's Source media row offers Add folder… only while Use default folders is off (or folders exist).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let estimate: unknown = {};
let storageFolders: unknown[] = [];
let watch: unknown = { allowed: true, folders: [], missing: 0 };
const deleted: string[] = [];
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.includes("/estimate")) return ok(estimate);
    if (url.includes("/watch/size")) return ok({ files: 400, bytes: 400e9 });
    if (url.endsWith("/watch")) return ok(watch);
    if (init?.method === "DELETE") return deleted.push(url), ok({ folders: [] });
    if (url.startsWith("/api/devices/storage")) return ok({ folders: storageFolders, serverDisks: [], here: [] });
    if (url.startsWith("/api/providers")) return ok({ devices: [] });
    return ok({});
  });
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = undefined;
  clearLocalCache();
  vi.unstubAllGlobals();
});

async function render(el: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(el));
  for (let i = 0; i < 6; i++) await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
}

const SETTINGS: LibrarySettings = { describe: true, look: true, timeline: true, embed: true, proxy: true, upload: "none", lookLevel: "standard", lookBudget: null };
const library: LibrarySummary = { id: "lib_1", name: "Tiny Acrobatics", storage: "local", settings: SETTINGS };
const buttons = (text: string) => [...(host?.querySelectorAll("button") ?? [])].filter((b) => b.textContent?.trim() === text);

describe("EffortCost: About $N on the Effort row", () => {
  it("shows the cost of the footage not analyzed yet: 31 hours at $0.45 an hour is About $14", async () => {
    estimate = { unanalyzed: { seconds: 31 * 3600, hourUsd: 0.45 } };
    await render(<EffortCost libraryId="lib_1" level="high" />);
    expect(host!.textContent).toContain("About $14");
    const tip = host!.querySelector<HTMLButtonElement>(`button[aria-label="About ${LIBRARY_WORDS.effort}"]`);
    expect(tip).not.toBeNull();
  });

  it("is hidden at Off", async () => {
    estimate = { unanalyzed: { seconds: 31 * 3600, hourUsd: 0.45 } };
    await render(<EffortCost libraryId="lib_1" level="off" />);
    expect(host!.textContent ?? "").not.toContain("About $");
  });

  it("with nothing left to analyze it still reads About $0 (the copy shows the value at every effort but Off)", async () => {
    estimate = { unanalyzed: { seconds: 0, hourUsd: 0.45 } };
    await render(<EffortCost libraryId="lib_1" level="high" />);
    expect(host!.textContent).toContain("About $0");
  });
});

describe("OwnerFolders: Source media's Add folder… follows Use default folders", () => {
  const owner = (defaultFolders: boolean): LibrarySummary => ({ ...library, settings: { ...SETTINGS, defaultFolders } });

  it("with Use default folders on and no folder made (no computer here), Source media has no Add folder… button", async () => {
    storageFolders = [];
    await render(<OwnerFolders library={owner(true)} workspace={null} onChange={() => {}} onError={() => {}} />);
    expect(buttons("Add folder…")).toHaveLength(0);
    expect(buttons("Set…")).toHaveLength(0);
  });

  it("with Use default folders off, every folder not chosen yet shows Set…", async () => {
    storageFolders = [];
    await render(<OwnerFolders library={owner(false)} workspace={null} onChange={() => {}} onError={() => {}} />);
    expect(buttons(LIBRARY_WORDS.setFolder)).toHaveLength(3);
    expect(buttons("Add folder…")).toHaveLength(0);
  });
});

// 11-19 (CEO): a folder is added at once, nothing asks first; its row says what indexing it takes, with Cancel
describe("OwnerFolders: a folder being indexed", () => {
  const row = { id: "f1", role: "footage", name: "Trips", origin: { host: "mac-1", path: "/Volumes/Tiny/Trips" }, make: false, createdAt: 1, folderState: "ok", checkedAt: 1, workspace: "*" };
  beforeEach(() => {
    storageFolders = [row];
    watch = { allowed: true, folders: [{ path: "/Volumes/Tiny/Trips", mode: "reference", found: true, files: 400, adding: 312, imported: 88 }], missing: 0 };
    estimate = { steps: [{ usd: 30 }, { usd: 10 }] };
    deleted.length = 0;
  });

  it("says how many clips are left and the cost total, and Cancel takes the folder off the list", async () => {
    await render(<OwnerFolders library={library} workspace={null} onChange={() => {}} onError={() => {}} />);
    expect(host!.textContent).toContain("Indexing 312 clips · about $40");
    await act(async () => buttons("Cancel")[0]!.click());
    expect(deleted).toEqual(["/api/devices/storage/folders/f1"]);
  });

  it("shows no cost at Effort Off", async () => {
    const off: LibrarySummary = { ...library, settings: { ...SETTINGS, describe: false, look: false, timeline: false, embed: false, transcribe: false, pictures: false } };
    await render(<OwnerFolders library={off} workspace={null} onChange={() => {}} onError={() => {}} />);
    expect(host!.textContent).toContain("Indexing 312 clips");
    expect(host!.textContent).not.toContain("about $");
  });
});

