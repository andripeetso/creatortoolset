// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Undo's notice is not drawn here: what it would take back is kept, for a test to run
const undos = vi.hoisted(() => [] as { what: string; back: () => unknown }[]);
vi.mock("@/lib/undo", async (orig) => ({ ...(await orig<object>()), undoable: (what: string, back: () => unknown) => void undos.push({ what, back }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETTINGS: LibrarySettings = { describe: true, look: true, timeline: true, embed: true, proxy: true, upload: "none", lookLevel: "standard", lookBudget: null };
const library: LibrarySummary = { id: "lib_1", name: "Tiny Acrobatics", storage: "local", mayKeepAsFilmed: true, settings: SETTINGS };
const watch = { allowed: false, folders: [], missing: 0 };
const patches: unknown[] = [];
/** each request with the workspace it named */
const asked: Array<[string, string | null]> = [];
let serverHere = false;
let storageFolders: unknown[] = [];
/** what GET /made answers (api/library/made.ts) */
let made: unknown[] = [];

let root: Root | undefined;
let host: HTMLDivElement | undefined;
beforeEach(() => {
  patches.length = 0;
  asked.length = 0;
  undos.length = 0;
  serverHere = false;
  storageFolders = [];
  made = [];
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
    if (url.endsWith("/made")) return ok(made);
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
  useAuth.setState({ me: null, kind: "server" });
  useWorkspace.setState({ loaded: false, currentProjectId: null, projects: [] });
  vi.unstubAllGlobals();
  // between tests and after the last, no request may reach the network: one would be a page still mounted
  vi.stubGlobal("fetch", (url: string) => {
    late.push(String(url));
    throw new Error(`a request after its test ended: ${url}`);
  });
});
/** the requests made after a test ended (none: every page was unmounted) */
const late: string[] = [];
// the spy stays to the end of the file (each file runs on its own): a request later than this check still never reaches
// the network, and throws with its URL
afterAll(async () => {
  await new Promise((done) => setTimeout(done, 50));
  expect(late).toEqual([]);
});

async function render(el: ReactNode) {
  // a second render in one test unmounts the first: a page left mounted fetches for real once the test ends
  if (root) act(() => root!.unmount());
  host?.remove();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter>{el}</MemoryRouter>));
  for (let i = 0; i < 6; i++) await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
}

/** The owner page's sections, in the order the page draws them (the §3.1 order). */
const SECTION_TITLES = [LIBRARY_WORDS.foldersTitle, LIBRARY_WORDS.organizationTitle, LIBRARY_WORDS.proxyTitle, LIBRARY_WORDS.hostedTitle, LIBRARY_WORDS.analysisTitle, LIBRARY_WORDS.madeTitle, LIBRARY_WORDS.modelsTitle];
const headings = () => [...host!.querySelectorAll("h2")].map((h) => h.textContent ?? "");
const bodyText = () => document.body.textContent ?? "";
/** a radio input by its label (RadioList gives each its label as aria-label) */
const radio = (label: string) => host!.querySelector<HTMLInputElement>(`input[type="radio"][aria-label="${label}"]`)!;
const toggle = (label: string) => host!.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`)!;
const tip = (label: string) => host!.querySelector<HTMLButtonElement>(`button[aria-label="About ${label}"]`);
/** a press whose save has answered */
const press = async (el: HTMLElement) => {
  act(() => el.click());
  for (let i = 0; i < 4; i++) await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
};

describe("Settings → Media Library, the owner's page", () => {
  // replaced (UNIFIED-PRD Rulings 11-19): All clips left the owner page; its Redo is in the Library's ⋯ menu
  it("draws its sections in the §3.1 order, with Copies last", async () => {
    await render(<LibrarySettingsBody library={library} watch={watch} onChange={() => {}} onError={() => {}} />);
    expect(headings().slice(0, SECTION_TITLES.length)).toEqual(SECTION_TITLES);
    expect(headings()).not.toContain("All clips");
  });

  it("has no description line under any row: the words of a tip stay out of the page until its ⓘ is opened", async () => {
    await render(<LibrarySettingsBody library={library} watch={watch} onChange={() => {}} onError={() => {}} />);
    for (const t of [LIBRARY_WORDS.smartFolders.tip, LIBRARY_WORDS.generateProxies.tip, LIBRARY_WORDS.descriptionsTip]) expect(bodyText()).not.toContain(t);
  });

  // replaced (CEO 11-19 ruling 3): Effort is setup's six stops, its ⓘ on the title says what the chosen stop does
  it("gives each setting its ⓘ tip, Effort one for its chosen stop", async () => {
    await render(<LibrarySettingsBody library={library} watch={watch} onChange={() => {}} onError={() => {}} />);
    // replaced (CEO 11-19): the Library folder row took the Use default folders switch's place, with its own ⓘ
    for (const label of [LIBRARY_WORDS.libraryFolder.label, LIBRARY_WORDS.smartFolders.label, LIBRARY_WORDS.generateProxies.label, LIBRARY_WORDS.descriptions, LIBRARY_WORDS.videoBreakdown, LIBRARY_WORDS.transcripts]) {
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

  it("Smart folders stay a choice while Effort is Off: they file by shoot with no AI", async () => {
    const off: LibrarySummary = { ...library, settings: { ...SETTINGS, describe: false, look: false, timeline: false, embed: false, transcribe: false, lookLevel: "standard" } };
    await render(<LibrarySettingsBody library={off} watch={watch} onChange={() => {}} onError={() => {}} />);
    expect(radio("Smart folders").disabled).toBe(false);
    expect(radio("Organize yourself").disabled).toBe(false);
    expect(bodyText()).not.toContain("Analysis is Off");
    expect(host!.querySelector('[aria-label="Effort"] [aria-checked="true"]')!.textContent).toBe("Off");
  });

  it("the Proxy quality radio shows only while proxies are generated", async () => {
    const noProxy: LibrarySummary = { ...library, settings: { ...SETTINGS, proxy: false } };
    await render(<LibrarySettingsBody library={noProxy} watch={watch} onChange={() => {}} onError={() => {}} />);
        expect(host!.querySelector('input[name="proxy-quality"]')).toBeNull();
  });

  it("while Hosted media hosts proxies, Generate proxies is its own switch: off stays off and can be turned on (owner, 2026-11-25)", async () => {
    const hosted: LibrarySummary = { ...library, settings: { ...SETTINGS, proxy: false, upload: "proxies" } };
    await render(<LibrarySettingsBody library={hosted} watch={watch} onChange={() => {}} onError={() => {}} />);
    const gen = toggle(LIBRARY_WORDS.generateProxies.label);
    expect(gen.getAttribute("aria-checked")).toBe("false");
    expect(gen.disabled).toBe(false);
  });

  // replaced (Andri 11-19): Upload to server is one pick-one, as in setup; on This Mac it is a row saying there is no server
  it("on This Mac with no server connected, Upload to server says so and offers no choice, whatever is stored", async () => {
    serverHere = true;
    const stored: LibrarySummary = { ...library, settings: { ...SETTINGS, upload: "all" } };
    useAuth.setState({ kind: "mac" });
    await render(<LibrarySettingsBody library={stored} watch={{ ...watch, allowed: true }} onChange={() => {}} onError={() => {}} />);
    expect(bodyText()).toContain("No server connected");
    expect(host!.querySelector('button[role="switch"][aria-label="Proxies"]')).toBeNull();
  });

  it("a Server opened in the Mac app by its admin keeps its Upload to server choices, so hosted proxies can be turned off", async () => {
    serverHere = true;
    useAuth.setState({ kind: "server" });
    const stored: LibrarySummary = { ...library, settings: { ...SETTINGS, upload: "all" } };
    await render(<LibrarySettingsBody library={stored} watch={{ ...watch, allowed: true }} onChange={() => {}} onError={() => {}} />);
    expect(bodyText()).not.toContain("No server connected");
  });

  it("with Use default folders off, a Source media folder not chosen yet shows Set…", async () => {
    const off: LibrarySummary = { ...library, settings: { ...SETTINGS, defaultFolders: false } };
    await render(<LibrarySettingsBody library={off} watch={watch} onChange={() => {}} onError={() => {}} />);
    const setButtons = [...host!.querySelectorAll("button")].filter((b) => b.textContent === LIBRARY_WORDS.setFolder && !b.closest("[inert]"));
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

  it("What's made: one switch per kind for new files, saving only its setting; no Make here (Library status has it)", async () => {
    await render(<LibrarySettingsBody library={library} watch={watch} onChange={() => {}} onError={() => {}} />);
    const sw = host!.querySelector('[aria-label="Descriptions and tags for new files"]') as HTMLButtonElement;
    await act(async () => sw.click());
    expect(patches.at(-1)).toEqual({ settings: { describe: !library.settings.describe } });
    expect(asked.some(([r]) => r.startsWith("POST"))).toBe(false);
    expect([...host!.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Make "))).toBe(false);
    // proxies and blurred copies are Proxy workflow's switches, not again here
    expect(host!.querySelector('[aria-label="Proxies for new files"]')).toBeNull();
  });

  it("Blur faces and Generate proxies are two switches of Proxy workflow; Upload offers Blurred and Proxies, never Originals", async () => {
    made = [{ kind: "blur", have: 14, missing: 0, queued: 0, cost: "tokens" }];
    const blurs = { ...library, settings: { ...library.settings, blurFaces: true, proxy: true, upload: "all" as const } };
    await render(<LibrarySettingsBody library={blurs} watch={watch} onChange={() => {}} onError={() => {}} />);
    const sw = [...host!.querySelectorAll('[aria-label="Blur faces"]')];
    expect(sw).toHaveLength(1); // not again under Hosted media
    // the chain: the proxy is made from the blurred copy, and neither switch hides the other
    for (const words of ["Generate proxies", LIBRARY_WORDS.proxiesFromBlurred, "Proxy quality"]) expect(bodyText()).toContain(words);
    const row = (label: string) => host!.querySelector(`button[role="switch"][aria-label="${label}"]`);
    expect([!!row("Blurred"), !!row("Proxies"), !!row("Originals")]).toEqual([true, true, false]);
    // off: Blurred (the Originals part) does not become Originals, and Generate proxies is left as it is
    await act(async () => (sw[0] as HTMLButtonElement).click());
    expect(patches.at(-1)).toEqual({ settings: { blurFaces: false, upload: "proxies", finalsUpload: expect.any(String) } });
  });

  it("under Blur faces with Generate proxies off, Upload offers no Proxies row", async () => {
    const blurs = { ...library, settings: { ...library.settings, blurFaces: true, proxy: false, upload: "originals" as const } };
    await render(<LibrarySettingsBody library={blurs} watch={watch} onChange={() => {}} onError={() => {}} />);
    const row = (label: string) => host!.querySelector(`button[role="switch"][aria-label="${label}"]`);
    expect([row("Blurred")?.getAttribute("aria-checked"), !!row("Proxies")]).toEqual(["true", false]);
    expect(bodyText()).not.toContain(LIBRARY_WORDS.proxiesFromBlurred);
  });

  it("with Generate proxies off, Upload offers no Proxies row in a library that doesn't blur either", async () => {
    const off: LibrarySummary = { ...library, settings: { ...SETTINGS, proxy: false } };
    await render(<LibrarySettingsBody library={off} watch={watch} onChange={() => {}} onError={() => {}} />);
    const row = (label: string) => host!.querySelector(`button[role="switch"][aria-label="${label}"]`);
    expect([!!row("Final exports"), !!row("Proxies"), !!row("Originals")]).toEqual([true, false, true]);
  });

  it("Generate proxies off turns Upload's Proxies off in the same save, and Undo puts both back", async () => {
    const hosts: LibrarySummary = { ...library, settings: { ...SETTINGS, upload: "all", finalsUpload: "all" } };
    await render(<LibrarySettingsBody library={hosts} watch={watch} onChange={() => {}} onError={() => {}} />);
    await press(toggle(LIBRARY_WORDS.generateProxies.label));
    expect(patches).toEqual([{ settings: { proxy: false, upload: "originals", finalsUpload: "all" } }]);
    expect(undos.map((u) => u.what)).toEqual([LIBRARY_WORDS.proxiesOff]);
    await act(async () => void (await undos[0]!.back()));
    // Undo says it is one (proxyBack), so the switch keeps its time and the proxies that were waiting come back
    expect(patches.at(-1)).toEqual({ settings: { proxy: true, proxyBack: true, upload: "all", finalsUpload: "all" } });
  });

  it("Generate proxies off where Upload sent no proxies saves only itself and offers no Undo: the switch shows it all", async () => {
    await render(<LibrarySettingsBody library={library} watch={watch} onChange={() => {}} onError={() => {}} />);
    await press(toggle(LIBRARY_WORDS.generateProxies.label));
    expect(patches).toEqual([{ settings: { proxy: false } }]);
    expect(undos).toEqual([]);
  });

  it("asks nothing about how to import: where a file is decides", async () => {
    await render(<LibrarySettingsBody library={library} watch={watch} onChange={() => {}} onError={() => {}} />);
    expect(bodyText()).not.toContain("How should imported media behave?");
  });

  it("a library given to this person (not the owner's) renders the member page, not the owner's sections", async () => {
    const given: LibrarySummary = { ...library, readOnly: true };
    await render(<LibrarySettingsBody library={given} watch={watch} onChange={() => {}} onError={() => {}} />);
    expect(headings()).not.toContain(LIBRARY_WORDS.organizationTitle);
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
