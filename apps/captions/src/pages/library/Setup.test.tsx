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
}));

vi.mock("@/components/settings/ThisMacSection", () => ({ hasThisMac: () => h.mac }));
vi.mock("@/components/settings/StorageRows", () => ({
  STORAGE_API: "/api/devices/storage",
  call: async (url: string, _method: string, body: Record<string, unknown>, workspace?: string | null) => {
    h.calls.push({ url, body, workspace });
    if (h.failMake && body.make) throw new Error("That folder could not be made on this computer");
    return {};
  },
}));
vi.mock("@/lib/library", () => ({
  updateLibrary: async (id: string, patch: { settings: Record<string, unknown> }) => {
    h.updates.push({ id, settings: patch.settings });
    return { id, name: "Tiny", storage: "local", settings: patch.settings };
  },
}));
vi.mock("@/lib/auth", () => ({
  useAuth: (sel: (s: { hosted: boolean }) => unknown) => sel({ hosted: h.hosted }),
  useMe: () => ({ username: "tiny", name: "Tiny" }),
}));
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

async function mount(kind: Kind) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const library = { id: "lib_1", name: "Tiny", storage: "local" as const, settings: { describe: true, embed: true, look: true, timeline: true, proxy: true, upload: "none" as const, lookLevel: "standard" as const, lookBudget: null } };
  act(() => {
    root!.render(
      <MemoryRouter>
        <LibrarySetup library={library} watchAllowed={kind === "mac"} onDone={onDone} onClose={onClose} />
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
/** writes into a text field by its label, the way a person types (React sees the change) */
const type = async (label: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
};
const submit = async (label: string) => {
  const form = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.closest("form")!;
  act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await flush();
};
const toggle = (label: string) => press(document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? undefined);
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

  it("with the default folders switched off, Continue waits until Source media, Project files and Final exports are all set", async () => {
    await mount("mac");
    await next(); // scratch: to Folders
    await toggle("Use default folders"); // off: three Set… rows
    expect(button("Continue")?.disabled).toBe(true);
    await press(buttons("Set…")[0]); // Source media
    await type("Source media folder path", "/Volumes/NAS/Media");
    await submit("Source media folder path");
    await press(buttons("Set…")[1]); // Project files (the first button stays Set… after its row is set)
    await type("Project files folder path", "/Volumes/NAS/Projects");
    await submit("Project files folder path");
    expect(button("Continue")?.disabled).toBe(true); // Final exports still not set
    await press(buttons("Set…")[2]);
    await type("Final exports folder path", "/Volumes/NAS/Exports");
    await submit("Final exports folder path");
    expect(button("Continue")?.disabled).toBe(false);
  });
});

describe("Media Library setup: existing folders", () => {
  it("needs one Source media folder; Project files and Final exports go beside it by default", async () => {
    await mount("mac");
    await press(button("Use my existing folders"));
    await next(); // to Folders: no folder yet
    expect(button("Continue")?.disabled).toBe(true);
    await press(button("Add folder…"));
    await type("Source media folder path", "/Volumes/NAS/Media");
    await submit("Source media folder path");
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
    await press(button("Add folder…"));
    await type("Source media folder path", "/Volumes/NAS/Media");
    await submit("Source media folder path");
    await press(button("Use files where they are"));
    await next();
    await next();
    await press(button("Done"));
    expect(h.updates[0]!.settings).toMatchObject({ importMode: "in-place" });
  });
});

describe("Media Library setup: own server and Cloud", () => {
  it("an own server has five steps; Upload to server turns Proxies on and saves proxies, Final exports on", async () => {
    h.mac = false; // a browser on the server: no folder rows here
    await mount("server");
    expect(dots()).toBe(5);
    await next(); // to Folders: the Mac app is named, not a folder picker
    expect(document.body.textContent).toContain("Folders are added in the Mac app.");
    await next(); // proxy
    await next(); // analysis
    await next(); // hosted
    expect(button("Done")).toBeDefined();
    await toggle("Upload to server");
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Proxies"]')?.getAttribute("aria-checked")).toBe("true");
    await press(button("Done"));
    expect(h.calls).toEqual([]); // no Mac app, so no rows
    expect(h.updates[0]!.settings).toMatchObject({ upload: "proxies", finalsUpload: "all", proxy: true });
  });

  it("Cloud has five steps too, and Upload to server with Originals saves all", async () => {
    h.hosted = true;
    h.mac = false;
    await mount("cloud");
    expect(dots()).toBe(5);
    for (let i = 0; i < 4; i++) await next();
    await toggle("Upload to server");
    await toggle("Originals");
    await press(button("Done"));
    expect(h.updates[0]!.settings).toMatchObject({ upload: "all" });
  });

  it("with Final exports switched off, it is saved as none", async () => {
    await mount("server");
    for (let i = 0; i < 4; i++) await next();
    await toggle("Final exports");
    await press(button("Done"));
    expect(h.updates[0]!.settings).toMatchObject({ finalsUpload: "none", upload: "none" });
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
    const base: Parameters<typeof rowsOf>[0] = { start: "scratch", defaults: true, sources: [], projects: "", exports: "", copy: true, proxy: true, proxyQuality: "standard", effort: "high", watchModel: "gemini-3.8-flash", budget: null, organize: "ai", upload: false, originals: false, proxies: false, finals: true };
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
    await mount("server");
    for (let i = 0; i < 4; i++) await next(); // to Hosted media
    await toggle("Upload to server"); // Proxies is on with it
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

  it("the Models rows show at High and above; Video breakdown's pick is saved as the library's model", async () => {
    await mount("mac");
    for (let i = 0; i < 3; i++) await next();
    expect(document.body.textContent).toContain("Descriptions");
    expect(document.body.textContent).toContain("Transcripts");
    await press([...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((b) => b.textContent?.includes("Video breakdown")));
    await press([...document.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find((b) => b.textContent?.includes("Gemini 3.5 Flash-Lite")));
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
