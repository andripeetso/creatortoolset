// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIBRARY_SETUP_DONE } from "@contracts/library";
import { LibrarySetup, rowsOf, type Kind } from "./Setup";

// The owner's setup sheet, per path (scratch / existing folders) and per server kind (This Mac / own server / Cloud).
// The Mac bridge, the folder list, the library PATCH and the workspace are stubbed.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  mac: true,
  hosted: false,
  calls: [] as { url: string; body: Record<string, unknown>; workspace?: string | null }[],
  updates: [] as { id: string; settings: Record<string, unknown> }[],
  events: [] as CustomEvent[],
  failMake: false,
  /** what the Mac app's folder window answers, in order */
  picks: [] as string[],
  /** the Finder items of the drag dropped on the window */
  dropped: [] as { path: string; folder: boolean }[],
  paired: null as { device: string } | null,
  /** the Mac app's pairing answer (a test may make it never answer) */
  pair: (async () => null) as () => Promise<{ device: string } | null>,
  /** a folder role the server refuses, with its error */
  refuse: {} as Record<string, string>,
  /** the PATCH reply leaves setupAt out (a server from before it returned it) */
  dropSetupAt: false,
  /** the server's own name (GET /api/work/server-work) */
  serverName: "Tiny's server" as string | undefined,
}));

vi.mock("@/components/settings/ThisMacSection", () => ({ hasThisMac: () => h.mac }));
vi.mock("@/lib/thisMac", () => ({
  chooseFolderOnMac: async () => h.picks.shift() ?? null,
  droppedOnMac: async () => h.dropped,
  pairThisMac: () => h.pair(),
}));
vi.mock("@/components/settings/StorageRows", () => ({
  STORAGE_API: "/api/devices/storage",
  call: async (url: string, _method: string, body: Record<string, unknown>, workspace?: string | null) => {
    if (url === "/api/work/server-work") return { kind: "server", place: null, serverName: h.serverName };
    h.calls.push({ url, body, workspace });
    if (h.failMake && body.make) throw new Error("That folder could not be made on this computer");
    if (h.refuse[body.role as string]) throw new Error(h.refuse[body.role as string]);
    return {};
  },
}));
vi.mock("@/lib/library", () => ({
  updateLibrary: async (id: string, patch: { settings: Record<string, unknown> }) => {
    h.updates.push({ id, settings: patch.settings });
    const { setupAt, ...rest } = patch.settings;
    return { id, name: "Tiny", storage: "local", settings: h.dropSetupAt ? rest : { ...rest, setupAt } };
  },
  // the Effort row's "About $N" (EffortCost) asks for the estimate; no footage in these tests, so no figure
  getEstimate: async () => ({}),
}));
vi.mock("@/lib/auth", () => ({
  useAuth: (sel: (s: { hosted: boolean }) => unknown) => sel({ hosted: h.hosted }),
  useMe: () => ({ username: "tiny", name: "Tiny" }),
}));
// the Models rows read the model in use from the AI and Voice pages, as the owner page does (settings/Models.tsx)
vi.mock("@/lib/providers", async (orig) => ({
  ...(await orig<typeof import("@/lib/providers")>()),
  useProviders: () => ({ set: () => {}, data: { workspace: null, own: { instances: [{ id: "gem", driver: "gemini", name: "Gemini", enabled: true, model: "gemini-3.8-flash" }], default: { instance: "gem", model: "gemini-3.8-flash", effort: "high" }, jobs: {} }, using: "own", devices: [], checks: {}, models: {}, usage: [], limits: [] } }),
}));
vi.mock("@/lib/voice", async (orig) => ({
  ...(await orig<typeof import("@/lib/voice")>()),
  useVoice: () => ({ set: () => {}, data: { languages: [], stt: { default: { engine: "local" }, per: {} }, resolved: [], resolvedDefault: { use: "default", engine: "local", model: "whisper-base" }, available: [], availableFor: {}, computers: [] } }),
}));
vi.mock("@/components/settings/MyKeysSection", () => ({ useMyKeys: () => ({ data: [] }) }));
vi.mock("@/lib/workspace", () => ({
  currentProject: () => ({ id: "ws_1", name: "Tiny Acrobatics" }),
  useWorkspace: (sel: (s: object) => unknown) => sel({}),
}));

const onEvent = (e: Event) => h.events.push(e as CustomEvent);
const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const onDone = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  h.mac = true;
  h.hosted = false;
  h.calls = [];
  h.updates = [];
  h.events = [];
  h.failMake = false;
  h.picks = [];
  h.dropped = [];
  h.paired = null;
  h.pair = async () => h.paired;
  h.refuse = {};
  h.dropSetupAt = false;
  h.serverName = "Tiny's server";
  delete document.documentElement.dataset.macDevice;
  onDone.mockReset();
  onClose.mockReset();
  window.addEventListener(LIBRARY_SETUP_DONE, onEvent);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  window.removeEventListener(LIBRARY_SETUP_DONE, onEvent);
});

async function mount(kind: Kind, inline = false) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const library = { id: "lib_1", name: "Tiny", storage: "local" as const, settings: { describe: true, embed: true, look: true, timeline: true, proxy: true, upload: "none" as const, lookLevel: "standard" as const, lookBudget: null } };
  act(() => {
    root!.render(
      <MemoryRouter>
        <LibrarySetup library={library} watchAllowed={kind === "mac"} inline={inline} onDone={onDone} onClose={onClose} />
      </MemoryRouter>,
    );
  });
  await flush();
}

/** the buttons with this text, in the sheet (a portal, so the whole document) */
const buttons = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.trim() === text);
const button = (text: string) => buttons(text)[0];
const press = async (el: HTMLElement | undefined) => {
  if (!el) throw new Error("missing control");
  act(() => el.click());
  await flush();
};
const next = () => press(button("Continue"));
/** a switch by its label, and pressing it */
const sw = (label: string) => document.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`);
const toggle = (label: string) => press(sw(label) ?? undefined);
/** the page's text as read, without the break hints in long paths */
const shown = () => (document.body.textContent ?? "").replace(/\u200b/g, "");
const dots = () => document.querySelector('[aria-label="Steps"]')?.children.length ?? 0;
const folderPaths = () => h.calls.map((c) => c.body.path);

describe("Media Library setup: scratch, This Mac", () => {
  it("makes the three default folders as rows and saves the answers with setupAt, then says it is done", async () => {
    await mount("mac");
    expect(dots()).toBe(4); // This Mac has no Hosted media step
    expect(document.body.textContent).toContain("Let's set up the Media Library");
    await next(); // scratch, Use default folders on: to Folders
    await next(); // to Proxy workflow
    await next(); // to Analysis and organization
    await press(button("Done"));

    expect(folderPaths()).toEqual(["~/Movies/Creator Toolset/Tiny Acrobatics/Source media", "~/Movies/Creator Toolset/Tiny Acrobatics/Project files", "~/Movies/Creator Toolset/Tiny Acrobatics/Final exports"]);
    expect(h.calls.map((c) => c.body.role)).toEqual(["footage", "projects", "library"]);
    expect(h.calls.every((c) => c.body.host === "this-computer" && c.workspace === "ws_1")).toBe(true);
    const s = h.updates[0]!.settings;
    expect(s).toMatchObject({ defaultFolders: true, importMode: "copy", organize: "ai", proxy: true, proxyQuality: "standard", describe: true, timeline: true, lookBudget: null });
    expect(typeof s.setupAt).toBe("string");
    expect(s).not.toHaveProperty("upload"); // a Mac library has no server to upload to
    expect(h.events.map((e) => e.detail)).toEqual([{ workspace: "ws_1" }]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("Finish later closes the sheet and writes nothing", async () => {
    await mount("mac");
    await press(button("Finish later"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it("Finish later is only on the sheet opened again: before setup the page is the setup, with nothing to close it", async () => {
    await mount("mac", true);
    expect(document.body.textContent).toContain("Let's set up the Media Library");
    expect(button("Finish later")).toBeUndefined();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  // replaced (Andri 11-19): folders are picked in the Mac app's folder window, never typed; no Use default folders switch
  it("Change… picks Source media in the Mac app's folder window; Project files and Final exports go beside it", async () => {
    await mount("mac");
    await next(); // scratch: to Folders, the defaults shown
    expect(shown()).toContain("~/Movies/Creator Toolset/Tiny Acrobatics/Source media");
    expect(document.querySelector('input[type="text"], input:not([type])')).toBeNull(); // nothing to type
    h.picks = ["/Volumes/NAS/Media/Footage"];
    await press(buttons("Change…")[0]);
    expect(shown()).toContain("/Volumes/NAS/Media/Project files");
    h.picks = ["/Volumes/NAS/Exports"];
    await press(buttons("Change…")[2]); // Final exports
    expect(button("Continue")?.disabled).toBe(false);
    await next(); // proxy
    await next(); // analysis
    await press(button("Done"));
    expect(folderPaths()).toEqual(["/Volumes/NAS/Media/Footage", "/Volumes/NAS/Media/Project files", "/Volumes/NAS/Exports"]);
    expect(h.calls.map((c) => c.body.make)).toEqual([undefined, undefined, undefined]); // a picked folder is there already
    expect(h.updates[0]!.settings).toMatchObject({ defaultFolders: false });
  });

  it("a Finder folder dropped on the Folders step becomes Source media, and the drop goes no further", async () => {
    const behind = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const library = { id: "lib_1", name: "Tiny", storage: "local" as const, settings: {} };
    // the Library page behind it takes drops as imports (its onDrop)
    act(() => root!.render(<MemoryRouter><div onDrop={behind}><LibrarySetup inline library={library as never} watchAllowed onDone={onDone} onClose={onClose} /></div></MemoryRouter>));
    await flush();
    await next();
    h.dropped = [{ path: "/Volumes/NAS/Trips", folder: true }, { path: "/Users/tiny/a.mp4", folder: false }];
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [], items: [], types: ["Files"] } });
    await act(async () => void host!.querySelector("section > div")!.dispatchEvent(drop));
    await flush();
    expect(shown()).toContain("/Volumes/NAS/Trips");
    expect(behind).not.toHaveBeenCalled();
  });
});

describe("Media Library setup: existing folders", () => {
  it("needs one Source media folder; Project files and Final exports go beside it by default", async () => {
    await mount("mac");
    await press(button("Use my existing folders"));
    await next(); // to Folders: no folder yet
    expect(button("Continue")?.disabled).toBe(true);
    h.picks = ["/Volumes/NAS/Media"];
    await press(button("Add folder…"));
    expect(button("Continue")?.disabled).toBe(false);
    await next(); // proxy
    await next(); // analysis
    await press(button("Done"));
    expect(folderPaths()).toEqual(["/Volumes/NAS/Media", "/Volumes/NAS/Project files", "/Volumes/NAS/Final exports"]);
    expect(h.updates[0]!.settings).toMatchObject({ defaultFolders: true, importMode: "copy" });
  });

  it("'Use files where they are' is saved as in-place", async () => {
    await mount("mac");
    await press(button("Use my existing folders"));
    await next();
    h.picks = ["/Volumes/NAS/Media"];
    await press(button("Add folder…"));
    await press(button("Use files where they are"));
    await next();
    await next();
    await press(button("Done"));
    expect(h.updates[0]!.settings).toMatchObject({ importMode: "in-place" });
  });
});

describe("Media Library setup: own server and Cloud", () => {
  // replaced (Andri 11-19, CEO 11-19): Upload to server is the master; Final exports, Proxies and Originals under it in any mix
  it("an own server has five steps; Final exports is on by default, and Proxies saves proxies and turns Proxies on", async () => {
    h.mac = false; // a browser on the server: no folder rows here
    await mount("server");
    expect(dots()).toBe(5);
    await next(); // to Folders: the Mac app is named, not a folder picker
    expect(document.body.textContent).toContain("Folders are added in the Mac app.");
    await next(); // proxy
    await next(); // analysis
    await next(); // hosted
    expect(button("Done")).toBeDefined();
    expect(sw("Upload to server")?.getAttribute("aria-checked")).toBe("true");
    expect(sw("Final exports")?.getAttribute("aria-checked")).toBe("true");
    await toggle("Proxies");
    await press(button("Done"));
    expect(h.calls).toEqual([]); // no Mac app, so no rows
    expect(h.updates[0]!.settings).toMatchObject({ upload: "proxies", finalsUpload: "all", proxy: true });
  });

  it("Cloud has five steps too; Originals without Proxies and without Final exports is a mix of its own", async () => {
    h.hosted = true;
    h.mac = false;
    await mount("cloud");
    expect(dots()).toBe(5);
    for (let i = 0; i < 4; i++) await next();
    await toggle("Originals");
    await toggle("Final exports");
    await press(button("Done"));
    expect(h.updates[0]!.settings).toMatchObject({ upload: "originals", finalsUpload: "none" });
  });

  it("the master off saves nothing uploaded, final exports included", async () => {
    h.mac = false;
    await mount("server");
    for (let i = 0; i < 4; i++) await next();
    await toggle("Upload to server");
    expect(sw("Final exports")).toBeNull(); // the three show only under the master on
    await press(button("Done"));
    expect(h.updates[0]!.settings).toMatchObject({ finalsUpload: "none", upload: "none" });
  });

  it("the master on again brings back the last mix; all three off is the master off; on from nothing is Final exports only", async () => {
    h.mac = false;
    await mount("server");
    for (let i = 0; i < 4; i++) await next();
    await toggle("Proxies"); // Final exports and Proxies
    await toggle("Upload to server");
    await toggle("Upload to server");
    expect(["Final exports", "Proxies", "Originals"].map((l) => sw(l)?.getAttribute("aria-checked"))).toEqual(["true", "true", "false"]);
    await toggle("Final exports");
    await toggle("Proxies");
    expect(sw("Upload to server")?.getAttribute("aria-checked")).toBe("false");
    act(() => root!.unmount());
    await mount("server");
    for (let i = 0; i < 4; i++) await next();
    await toggle("Upload to server"); // off (the default mix was on)
    act(() => root!.unmount());
    await mount("server"); // a new view: no earlier mix to bring back
    for (let i = 0; i < 4; i++) await next();
    await toggle("Final exports"); // all off
    await toggle("Upload to server");
    expect(["Final exports", "Proxies", "Originals"].map((l) => sw(l)?.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  });

  // the 11-19 miss: on Cloud the folders went to "this computer", which only a server on that computer knows
  it("in the Mac app on Cloud the folders are this Mac's, by its id on the server; an unpaired Mac is paired first", async () => {
    h.hosted = true;
    document.documentElement.dataset.macDevice = "dev_mac";
    await mount("cloud");
    for (let i = 0; i < 4; i++) await next();
    await press(button("Done"));
    expect(h.calls.map((c) => c.body.host)).toEqual(["dev_mac", "dev_mac", "dev_mac"]);
    expect(onDone).toHaveBeenCalledTimes(1);

    h.calls = [];
    delete document.documentElement.dataset.macDevice;
    h.paired = { device: "dev_new" };
    act(() => root!.unmount());
    await mount("cloud");
    for (let i = 0; i < 4; i++) await next();
    await press(button("Done"));
    expect(h.calls.map((c) => c.body.host)).toEqual(["dev_new", "dev_new", "dev_new"]);
  });

  it("in the Mac app on Cloud with no way to add this Mac, Done says so and saves nothing", async () => {
    h.hosted = true;
    await mount("cloud");
    for (let i = 0; i < 4; i++) await next();
    await press(button("Done"));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Connect this Mac");
    expect(h.updates).toEqual([]);
  });
});

describe("Media Library setup: analysis and organization", () => {
  it("Analysis Off makes Smart folders unavailable and files as Organize yourself", async () => {
    await mount("mac");
    for (let i = 0; i < 3; i++) await next(); // to Analysis and organization
    const effort = document.querySelector<HTMLInputElement>('input[aria-label="Effort"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(effort, "0");
      effort.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    expect(document.body.textContent).toContain("Analysis is Off");
    await press(button("Done"));
    expect(h.updates[0]!.settings).toMatchObject({ organize: "own", describe: false, transcribe: false });
  });
});

describe("rowsOf", () => {
  it("names the scratch folders for the workspace and puts the others beside the first Source media folder", () => {
    const base: Parameters<typeof rowsOf>[0] = { start: "scratch", sources: [], projects: "", exports: "", copy: true, proxy: true, proxyQuality: "standard", effort: "high", watchModel: "gemini-3.8-flash", budget: null, organize: "ai", hosted: { finals: true, proxies: false, originals: false } };
    expect(rowsOf(base, "Moo/Classic")).toEqual([
      { role: "footage", path: "~/Movies/Creator Toolset/Moo-Classic/Source media" },
      { role: "projects", path: "~/Movies/Creator Toolset/Moo-Classic/Project files" },
      { role: "library", path: "~/Movies/Creator Toolset/Moo-Classic/Final exports" },
    ]);
    expect(rowsOf({ ...base, start: "existing", sources: ["/Volumes/NAS/Media/Trips"] }, "x").slice(1)).toEqual([
      { role: "projects", path: "/Volumes/NAS/Media/Project files" },
      { role: "library", path: "/Volumes/NAS/Media/Final exports" },
    ]);
  });
});

describe("Media Library setup: the scratch folder is made before its row", () => {
  it("the Source media row asks the server to make it; Project files and Final exports are made with their rows", async () => {
    await mount("mac");
    await next();
    await next();
    await next();
    await press(button("Done"));
    expect(h.calls.map((c) => [c.body.role, c.body.make])).toEqual([
      ["footage", true],
      ["projects", undefined],
      ["library", undefined],
    ]);
  });

  it("a folder that cannot be made shows the error and saves nothing, so setup is not marked done", async () => {
    h.failMake = true;
    await mount("mac");
    for (let i = 0; i < 3; i++) await next();
    await press(button("Done"));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("could not be made");
    expect(h.updates).toEqual([]);
    expect(h.events).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("Media Library setup: proxies, analysis and organization details", () => {
  it("Hosted media's Proxies holds the proxy switch on and disabled, and a Back trip cannot switch it off", async () => {
    h.mac = false;
    await mount("server");
    for (let i = 0; i < 4; i++) await next(); // to Hosted media
    await toggle("Proxies");
    await press(button("Back"));
    await press(button("Back")); // proxy workflow
    const proxy = document.querySelector<HTMLButtonElement>('button[aria-label="Generate proxies for imported media"]')!;
    expect(proxy.getAttribute("aria-checked")).toBe("true");
    expect(proxy.disabled).toBe(true);
    expect(document.body.textContent).toContain("On while proxies are hosted");
    await press(button("Continue"));
    await press(button("Continue")); // to hosted, where Done is
    await press(button("Done"));
    expect(h.updates[0]!.settings).toMatchObject({ upload: "proxies", proxy: true });
  });

  it("Effort Off leaves Smart folders unavailable, and Effort back up picks it again", async () => {
    await mount("mac");
    for (let i = 0; i < 3; i++) await next();
    const effort = document.querySelector<HTMLInputElement>('input[aria-label="Effort"]')!;
    const setEffort = async (v: string) => {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(effort, v);
        effort.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await flush();
    };
    const smart = () => [...document.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find((b) => b.textContent?.includes("Smart folders"))!;
    await setEffort("0");
    expect(smart().disabled).toBe(true);
    await setEffort("3");
    expect(smart().disabled).toBe(false);
    expect(smart().getAttribute("aria-checked")).toBe("true");
  });

  // replaced (UNIFIED-PRD Rulings 11-19): Video breakdown is one shared row, its options a radio list (input), and the test reads the model in use from the AI and Voice pages.
  it("the Models rows show at High and above; Video breakdown's pick is saved as the library's model", async () => {
    await mount("mac");
    for (let i = 0; i < 3; i++) await next();
    expect(document.body.textContent).toContain("Descriptions");
    expect(document.body.textContent).toContain("Transcripts");
    expect(document.body.textContent).toContain("Gemini 3.8 Flash");
    expect(document.body.textContent).toContain("Whisper base");
    expect(document.body.textContent).not.toContain("Set in Settings");
    await press(document.querySelector<HTMLButtonElement>('button[aria-label="Video breakdown"]') ?? undefined);
    await press(document.querySelector<HTMLInputElement>('input[aria-label="Gemini 3.5 Flash-Lite"]') ?? undefined);
    await press(button("Done"));
    expect(h.updates[0]!.settings).toMatchObject({ timelineModel: "gemini-3.5-flash-lite" });
  });

  it("Models are hidden at Effort Off, and the budget reads No limit until one is set", async () => {
    await mount("mac");
    for (let i = 0; i < 3; i++) await next();
    expect(document.body.textContent).toContain("Monthly budget: No limit");
    const effort = document.querySelector<HTMLInputElement>('input[aria-label="Effort"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(effort, "0");
      effort.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    expect(document.body.textContent).not.toContain("Descriptions");
  });
});

describe("Media Library setup: the browser path", () => {
  it("a browser with no Mac app names the Mac app and offers its download", async () => {
    h.mac = false;
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await mount("server");
    await next();
    await press(button("Download the Mac app"));
    expect(open).toHaveBeenCalledWith("https://creatortoolset.com/download", "_blank", "noopener");
    open.mockRestore();
  });
});

// Done on a hosted server that isn't This Mac, inside the Mac app (the 11-19 Studio case): it saves, or one red line by the
// buttons names the step that stopped it; setupAt is sent last, so a stopped setup is never marked done
describe("Media Library setup: Done in the Mac app on a hosted server", () => {
  const toDone = async () => {
    h.hosted = true;
    document.documentElement.dataset.macDevice = "dev_mac";
    await mount("cloud");
    for (let i = 0; i < 4; i++) await next();
  };
  const alert = () => document.querySelector('[role="alert"]')?.textContent ?? "";

  it("folders already in the list are skipped and the setup is saved (his existing folders)", async () => {
    h.refuse = { footage: "That folder is already there", library: "That folder is already there" };
    await toDone();
    await press(button("Done"));
    expect(h.calls.map((c) => c.body.role)).toEqual(["footage", "projects", "library"]);
    expect(typeof h.updates[0]!.settings.setupAt).toBe("string");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(alert()).toBe("");
  });

  it("a folder the server refuses names its step, and nothing is saved", async () => {
    h.refuse = { library: "Needs a computer and a folder" };
    await toDone();
    await press(button("Done"));
    expect(alert()).toBe("Final exports folder: Needs a computer and a folder");
    expect(h.updates).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
    expect(button("Done")?.disabled).toBe(false); // Done can be pressed again
  });

  it("a Mac app that never answers the pairing stops waiting with a red line", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      h.hosted = true;
      h.pair = () => new Promise(() => {});
      await mount("cloud");
      for (let i = 0; i < 4; i++) await next();
      act(() => button("Done")!.click());
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
      expect(alert()).toContain("This Mac didn't answer");
      expect(h.calls).toEqual([]);
      expect(h.updates).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reply without setupAt says so instead of leaving the page as it was", async () => {
    h.dropSetupAt = true;
    await toDone();
    await press(button("Done"));
    expect(alert()).toContain("Saving the setup: The server didn't keep the setup");
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("Media Library setup: the server's name in Hosted media", () => {
  it("is the server's own name, as the member page's Server row says it: Cloud only where the server calls itself that", async () => {
    h.mac = false;
    h.hosted = true; // a hosted own server (the studio) is no Cloud
    await mount("cloud");
    for (let i = 0; i < 4; i++) await next();
    expect(document.body.textContent).toContain("Choose what goes to Tiny's server, so your team can play it.");
    act(() => root!.unmount());
    h.serverName = "Creator Toolset Cloud";
    await mount("cloud");
    for (let i = 0; i < 4; i++) await next();
    expect(document.body.textContent).toContain("Choose what goes to Creator Toolset Cloud, so your team can play it.");
  });
});

