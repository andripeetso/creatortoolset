// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIBRARY_WORDS, type LibrarySettings, type LibrarySummary } from "@contracts/library";
import { LibrarySettingsBody } from "@/pages/library/LibrarySettings";
import { useAuth } from "@/lib/auth";
import { clearLocalCache } from "@/lib/local-cache";
import { useWorkspace } from "@/lib/workspace";
import { MediaLibrarySection } from "./MediaLibrarySection";
import { PageActionContext } from "./page-action";
import { resetWorkspacePick } from "./workspace-pick";

// Settings → Media Library is the owner's page (UNIFIED-PRD §3.1): its sections in order, one row per setting, each
// label's ⓘ tip (not a line under the row), and the Effort and Hosted media states.

// the kit's select as a plain one, so a test can pick a value (the workspace selector is one)
vi.mock("@/components/settings/kit-controls", async (orig) => ({
  ...(await orig<object>()),
  SettingsSelect: ({ label, value, options, onValueChange }: { label: string; value: string; options: { value: string; label: string }[]; onValueChange: (v: string) => void }) => (
    <select aria-label={label} value={value} onChange={(e) => onValueChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETTINGS: LibrarySettings = { describe: true, look: true, timeline: true, embed: true, proxy: true, upload: "none", lookLevel: "standard", lookBudget: null };
const library: LibrarySummary = { id: "lib_1", name: "Tiny Acrobatics", storage: "local", settings: SETTINGS };
const watch = { allowed: false, folders: [], missing: 0 };
const patches: unknown[] = [];
/** each request with the workspace it named */
const asked: Array<[string, string | null]> = [];
let serverHere = false;
let storageFolders: unknown[] = [];

let root: Root | undefined;
let host: HTMLDivElement | undefined;
beforeEach(() => {
  patches.length = 0;
  asked.length = 0;
  serverHere = false;
  storageFolders = [];
  // the Mac app: the bridge is there, so the Mac-only rows show
  vi.stubGlobal("webkit", { messageHandlers: { thisMac: { postMessage: async () => ({}) } } });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    asked.push([`${init?.method ?? "GET"} ${url}`, new Headers(init?.headers).get("X-CT-Workspace")]);
    if (init?.method === "PATCH") {
      const b = JSON.parse(String(init.body)) as { settings: object };
      patches.push(b);
      return ok({ ...library, settings: { ...library.settings, ...b.settings } });
    }
    if (url === "/api/library") return ok({ libraries: [library] });
    if (url.endsWith("/watch")) return ok({ ...watch, allowed: serverHere });
    if (url.endsWith("/collections")) return ok({ collections: [] });
    if (url.endsWith("/space")) return ok({ videos: { onMac: 0, inPlace: 0, stored: { bytes: 0, files: 0 } }, proxies: { bytes: 0, files: 0 }, pictures: { bytes: 0, files: 0 }, models: null });
    if (url.endsWith("/status")) return ok({ clips: 0, unreadable: 0, stages: [] });
    if (url.includes("/estimate")) return ok({ steps: [], lookSpent: 0, lookLevels: [], timelineModels: [] });
    if (url.startsWith("/api/devices/storage")) return ok({ folders: storageFolders, serverDisks: [], here: [] });
    if (url.startsWith("/api/providers")) return ok({ devices: [] });
    return ok({});
  });
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = undefined;
  clearLocalCache();
  resetWorkspacePick();
  useAuth.setState({ me: null });
  useWorkspace.setState({ loaded: false, currentProjectId: null, projects: [] });
  vi.unstubAllGlobals();
});

async function render(el: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter>{el}</MemoryRouter>));
  for (let i = 0; i < 6; i++) await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
}

/** The owner page's sections, in the order the page draws them (the §3.1 order). */
const SECTION_TITLES = [LIBRARY_WORDS.importTitle, LIBRARY_WORDS.foldersTitle, LIBRARY_WORDS.organizationTitle, LIBRARY_WORDS.proxyTitle, LIBRARY_WORDS.hostedTitle, LIBRARY_WORDS.analysisTitle, LIBRARY_WORDS.modelsTitle];
const headings = () => [...host!.querySelectorAll("h2")].map((h) => h.textContent ?? "");
const bodyText = () => document.body.textContent ?? "";
/** a radio input by its label (RadioList gives each its label as aria-label) */
const radio = (label: string) => host!.querySelector<HTMLInputElement>(`input[type="radio"][aria-label="${label}"]`)!;
const toggle = (label: string) => host!.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`)!;
const tip = (label: string) => host!.querySelector<HTMLButtonElement>(`button[aria-label="About ${label}"]`);

describe("Settings → Media Library, the owner's page", () => {
  // replaced (UNIFIED-PRD Rulings 11-19): All clips left the owner page; its Redo is in the Library's ⋯ menu
  it("draws its sections in the §3.1 order, with Copies last", async () => {
    await render(<LibrarySettingsBody library={library} watch={watch} onChange={() => {}} onError={() => {}} />);
    expect(headings().slice(0, SECTION_TITLES.length)).toEqual(SECTION_TITLES);
    expect(headings()).not.toContain("All clips");
  });

  it("has no description line under any row: the words of a tip stay out of the page until its ⓘ is opened", async () => {
    await render(<LibrarySettingsBody library={library} watch={watch} onChange={() => {}} onError={() => {}} />);
    for (const t of [LIBRARY_WORDS.importCopy.tip, LIBRARY_WORDS.smartFolders.tip, LIBRARY_WORDS.generateProxies.tip, LIBRARY_WORDS.descriptionsTip]) expect(bodyText()).not.toContain(t);
  });

  // replaced (CEO 11-19 ruling 3): Effort is setup's six stops, its ⓘ on the title says what the chosen stop does
  it("gives each setting its ⓘ tip, Effort one for its chosen stop", async () => {
    await render(<LibrarySettingsBody library={library} watch={watch} onChange={() => {}} onError={() => {}} />);
    // replaced (CEO 11-19): the Library folder row took the Use default folders switch's place, with its own ⓘ
    for (const label of [LIBRARY_WORDS.importCopy.label, LIBRARY_WORDS.importInPlace.label, LIBRARY_WORDS.libraryFolder.label, LIBRARY_WORDS.smartFolders.label, LIBRARY_WORDS.generateProxies.label, LIBRARY_WORDS.descriptions, LIBRARY_WORDS.videoBreakdown, LIBRARY_WORDS.transcripts]) {
      expect(tip(label), label).not.toBeNull();
    }
    expect(tip(LIBRARY_WORDS.effort)).not.toBeNull();
    // the master has no ⓘ; the three under it have one each
    expect(tip(LIBRARY_WORDS.uploadToServer)).toBeNull();
    for (const label of ["Final exports", "Proxies", "Originals"]) expect(tip(label), label).not.toBeNull();
  });

  // replaced (CEO 11-19 ruling 3): the slider became the setup's stops, one component
  it("Effort has setup's six stops, the one in use is High, and High is the recommended one", async () => {
    await render(<LibrarySettingsBody library={library} watch={watch} onChange={() => {}} onError={() => {}} />);
    const stops = [...host!.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Effort"] [role="radio"]')];
    expect(stops.map((b) => b.textContent)).toEqual(["Off", "Low", "Medium", "High", "Extra high", "Max"]);
    expect(stops.filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.textContent)).toEqual(["High"]);
    expect(stops.find((b) => b.textContent === "High")!.title).toBe("Recommended");
    expect(bodyText()).toContain("Monthly budget: No limit");
  });

  it("Smart folders is disabled with its status while Effort is Off, and the stored choice stays", async () => {
    const off: LibrarySummary = { ...library, settings: { ...SETTINGS, describe: false, look: false, timeline: false, embed: false, transcribe: false, lookLevel: "standard" } };
    await render(<LibrarySettingsBody library={off} watch={watch} onChange={() => {}} onError={() => {}} />);
    expect(radio("Smart folders").disabled).toBe(true);
    expect(radio("Organize yourself").disabled).toBe(false);
    expect(bodyText()).toContain("Analysis is Off");
    expect(host!.querySelector('[aria-label="Effort"] [aria-checked="true"]')!.textContent).toBe("Off");
  });

  it("the Proxy quality radio shows only while proxies are generated", async () => {
    const noProxy: LibrarySummary = { ...library, settings: { ...SETTINGS, proxy: false } };
    await render(<LibrarySettingsBody library={noProxy} watch={watch} onChange={() => {}} onError={() => {}} />);
        expect(host!.querySelector('input[name="proxy-quality"]')).toBeNull();
  });

  it("while Hosted media hosts proxies, Generate proxies is on and disabled with its status", async () => {
    const hosted: LibrarySummary = { ...library, settings: { ...SETTINGS, proxy: false, upload: "proxies" } };
    await render(<LibrarySettingsBody library={hosted} watch={watch} onChange={() => {}} onError={() => {}} />);
    const gen = toggle(LIBRARY_WORDS.generateProxies.label);
    expect(gen.getAttribute("aria-checked")).toBe("true");
    expect(gen.disabled).toBe(true);
    expect(bodyText()).toContain("On while proxies are hosted");
  });

  // replaced (Andri 11-19): Upload to server is one pick-one, as in setup; on This Mac it is a row saying there is no server
  it("on This Mac with no server connected, Upload to server says so and offers no choice, whatever is stored", async () => {
    serverHere = true;
    const stored: LibrarySummary = { ...library, settings: { ...SETTINGS, upload: "all" } };
    await render(<LibrarySettingsBody library={stored} watch={{ ...watch, allowed: true }} onChange={() => {}} onError={() => {}} />);
    expect(bodyText()).toContain("No server connected");
    expect(host!.querySelector('button[role="switch"][aria-label="Proxies"]')).toBeNull();
  });

  it("an import mode never stored reads as Copy on a set-up library", async () => {
    const setUp: LibrarySummary = { ...library, settings: { ...SETTINGS, setupAt: "2026-11-01T00:00:00.000Z" } };
    await render(<LibrarySettingsBody library={setUp} watch={watch} onChange={() => {}} onError={() => {}} />);
    expect(radio("Copy into Source media").checked).toBe(true);
  });

  it("with Use default folders off, a Source media folder not chosen yet shows Set…", async () => {
    const off: LibrarySummary = { ...library, settings: { ...SETTINGS, defaultFolders: false } };
    await render(<LibrarySettingsBody library={off} watch={watch} onChange={() => {}} onError={() => {}} />);
    const setButtons = [...host!.querySelectorAll("button")].filter((b) => b.textContent === LIBRARY_WORDS.setFolder);
    expect(setButtons.length).toBe(3);
  });

  it("with Use default folders on, the Project files row is fixed: its menu has no Remove", async () => {
    storageFolders = [{ id: "f1", role: "projects", name: "Projects", origin: { host: "mac-1", path: "/Users/x/Movies/Creator Toolset/Tiny" }, make: true, createdAt: 1, folderState: "ok", checkedAt: 1, workspace: "*" }];
    await render(<LibrarySettingsBody library={library} watch={watch} onChange={() => {}} onError={() => {}} />);
    expect(host!.querySelector('button[aria-label="Actions for Projects"]')).not.toBeNull();
    await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-label="Actions for Projects"]')!.click());
    expect(bodyText()).not.toContain("Remove");
  });

  // replaced (Andri 11-19, CEO 11-19): the Upload to server master, Final exports · Proxies · Originals under it in any mix
  it("Upload to server is the master over Final exports, Proxies and Originals; each switch saves both values", async () => {
    const stored: LibrarySummary = { ...library, settings: { ...SETTINGS, upload: "none", finalsUpload: "all" } };
    await render(<LibrarySettingsBody library={stored} watch={watch} onChange={() => {}} onError={() => {}} />);
    expect(toggle(LIBRARY_WORDS.uploadToServer).getAttribute("aria-checked")).toBe("true");
    expect(toggle("Final exports").getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle("Originals").click());
    expect(patches.at(-1)).toEqual({ settings: { upload: "originals", finalsUpload: "all" } });
    await act(async () => toggle(LIBRARY_WORDS.uploadToServer).click());
    expect(patches.at(-1)).toEqual({ settings: { upload: "none", finalsUpload: "none" } });
  });

  it("Models shows the three rows, and hides at Off", async () => {
    await render(<LibrarySettingsBody library={library} watch={watch} onChange={() => {}} onError={() => {}} />);
    expect(headings()).toContain(LIBRARY_WORDS.modelsTitle);
    const off: LibrarySummary = { ...library, settings: { ...SETTINGS, describe: false, look: false, timeline: false, embed: false, transcribe: false, lookLevel: "standard" } };
    await render(<LibrarySettingsBody library={off} watch={watch} onChange={() => {}} onError={() => {}} />);
    expect(headings()).not.toContain(LIBRARY_WORDS.modelsTitle);
  });

  it("saves a picked import mode", async () => {
    await render(<LibrarySettingsBody library={library} watch={watch} onChange={() => {}} onError={() => {}} />);
    expect(radio("Use files where they are").checked).toBe(true);
    await act(async () => radio("Copy into Source media").click());
    expect(patches.at(-1)).toEqual({ settings: { importMode: "copy" } });
  });

  it("a library given to this person (not the owner's) renders the member page, not the owner's sections", async () => {
    const given: LibrarySummary = { ...library, readOnly: true };
    await render(<LibrarySettingsBody library={given} watch={watch} onChange={() => {}} onError={() => {}} />);
    expect(headings()).not.toContain(LIBRARY_WORDS.importTitle);
    // the member page (UNIFIED-PRD §3.2): the workspace's settings, read only
    expect(headings()).toContain("Workspace settings");
  });

  it("the workspace picked in the header is the one its requests name, and the window stays in its own", async () => {
    useAuth.setState({ required: true, me: { username: "sam", role: "admin", cloud: false, off: [] } });
    useWorkspace.setState({
      loaded: true,
      currentProjectId: "p1",
      projects: [
        { id: "p1", owner: "sam", name: "Tiny Acrobatics", createdAt: 1 },
        { id: "p2", owner: "sam", name: "Tiny Acrobatics shop", createdAt: 2 },
      ] as ReturnType<typeof useWorkspace.getState>["projects"],
    });
    const header = document.body.appendChild(document.createElement("div"));
    await render(
      <PageActionContext.Provider value={header}>
        <MediaLibrarySection />
      </PageActionContext.Provider>,
    );
    const pick = header.querySelector('select[aria-label="Workspace"]') as HTMLSelectElement;
    expect(pick.value).toBe("p1");
    asked.length = 0;
    await act(async () => {
      pick.value = "p2";
      pick.dispatchEvent(new Event("change", { bubbles: true }));
    });
    for (let i = 0; i < 4; i++) await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
    expect(asked.find(([what]) => what === "GET /api/library")).toEqual(["GET /api/library", "p2"]);
    expect(useWorkspace.getState().currentProjectId).toBe("p1");
    header.remove();
  });
});
