// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary } from "@contracts/library";
import { LibrarySettings, LibrarySettingsBody } from "@/pages/library/LibrarySettings";
import { UploadSelect } from "@/pages/library/UploadSelect";
import { useAuth } from "@/lib/auth";
import { clearLocalCache } from "@/lib/local-cache";
import { useWorkspace } from "@/lib/workspace";
import { MediaLibrarySection } from "./MediaLibrarySection";
import { PageActionContext } from "./page-action";
import { resetWorkspacePick } from "./workspace-pick";

// Settings → Media Library is the library's own settings sheet, the same sections in both, for the workspace its
// selector shows; the upload choice is one select whose answer is saved on the library.

// the kit's select as a plain one, so a test can pick a value (the kit's own file: the workspace selector reads it there)
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

const library: LibrarySummary = { id: "lib_1", name: "Tiny Acrobatics", storage: "local", settings: { describe: true, look: true, timeline: true, embed: true, proxy: true, upload: "none", lookLevel: "standard", lookBudget: 20 } };
const watch = { allowed: false, folders: [], missing: 0 };
const patches: unknown[] = [];
/** each request with the workspace it named */
const asked: Array<[string, string | null]> = [];
let serverHere = false;
let stopped: "free" | "credit" | null = null;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
beforeEach(() => {
  patches.length = 0;
  asked.length = 0;
  serverHere = false;
  stopped = null;
  // the Mac app with the server elsewhere: every section shows
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
    if (url.endsWith("/usage")) return ok({ kind: "local", keysSet: false, serverBucket: false, locked: true, days: [] });
    if (url.endsWith("/space")) return ok({ videos: { onMac: 0, inPlace: 0, stored: { bytes: 0, files: 0 } }, proxies: { bytes: 0, files: 0 }, pictures: { bytes: 0, files: 0 }, models: null });
    if (url.includes("/estimate"))
      return ok({
        steps: [],
        lookSpent: 4.2,
        timelineKey: true,
        ...(stopped ? { timelineStopped: stopped } : {}),
        timelineModels: [
          { model: "gemini-3.8-flash", usd: 0.42 },
          { model: "gemini-3.5-flash-lite", usd: 0.16 },
        ],
        lookLevels: [{ level: "light", seconds: 300, usd: 0.9 }, { level: "standard", seconds: 720, usd: 2.64 }, { level: "detailed", seconds: 1440, usd: 5.28 }] });
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
  for (let i = 0; i < 4; i++) await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
}

const SECTIONS = ["Files", "Footage folders", "Storage", "Search", "All clips"];
const WITHOUT_FOLDERS = SECTIONS.filter((s) => s !== "Footage folders");
const headings = (text: string) => SECTIONS.filter((s) => text.includes(s));

describe("the Media Library's settings", () => {
  it("Settings → Media Library shows the sheet's sections", async () => {
    await render(<MediaLibrarySection />);
    expect(headings(document.body.textContent ?? "")).toEqual(WITHOUT_FOLDERS);
    // the folder choices by the names the first add offers them under: a name says what the choice does
    expect([...document.querySelector<HTMLSelectElement>('select[aria-label="Folders"]')!.options].map((o) => o.textContent)).toEqual(["Standard", "Automatic", "None"]);
  });

  it("on the server's own computer the sheet has the footage folders and the folder copies go into; Settings leaves both to its Folders page", async () => {
    serverHere = true;
    const copying = { ...library, settings: { ...library.settings, importMode: "copy" as const } };
    await render(<LibrarySettings open onOpenChange={() => {}} library={copying} watch={{ ...watch, allowed: true }} folders={[]} onChange={() => {}} onError={() => {}} />);
    for (let i = 0; i < 4; i++) await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
    expect(headings(document.body.textContent ?? "")).toEqual(SECTIONS);
    expect(document.body.textContent).toContain("Library folder");
    act(() => root!.unmount());
    host!.remove();
    await render(<LibrarySettingsBody inSettings library={copying} watch={{ ...watch, allowed: true }} folders={[]} onChange={() => {}} onError={() => {}} />);
    expect(headings(document.body.textContent ?? "")).toEqual(WITHOUT_FOLDERS);
    expect(document.body.textContent).not.toContain("Library folder");
  });

  it("shows the library of the workspace picked in its header: the requests name that workspace, and the window stays in its own", async () => {
    useAuth.setState({ required: true, me: { username: "sam", role: "admin", cloud: false, off: [] } });
    useWorkspace.setState({
      loaded: true,
      currentProjectId: "p1",
      projects: [
        { id: "p1", owner: "sam", name: "Tiny Acrobatics", createdAt: 1 },
        { id: "p2", owner: "sam", name: "Tiny Acrobatics shop", createdAt: 2 },
        // one the team's owner gave this person: its library is the owner's, so it is not offered
        { id: "p3", owner: "ana", name: "Given", createdAt: 3 },
      ] as ReturnType<typeof useWorkspace.getState>["projects"],
    });
    const header = document.body.appendChild(document.createElement("div"));
    await render(
      <PageActionContext.Provider value={header}>
        <MediaLibrarySection />
      </PageActionContext.Provider>,
    );
    const pick = header.querySelector('select[aria-label="Workspace"]') as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(["Tiny Acrobatics", "Tiny Acrobatics shop"]);
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

  it("the library's own sheet shows the same", async () => {
    await render(<LibrarySettings open onOpenChange={() => {}} library={library} watch={watch} folders={[]} onChange={() => {}} onError={() => {}} />);
    for (let i = 0; i < 4; i++) await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
    expect(headings(document.body.textContent ?? "")).toEqual(WITHOUT_FOLDERS);
  });

  it("Shot detail lists each level with an hour's time and cost, and saves the level picked and the monthly budget", async () => {
    await render(<LibrarySettingsBody library={library} watch={watch} folders={[]} onChange={() => {}} onError={() => {}} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("About 12 min and $2.64 an hour of footage");
    expect(text).toContain("$4.20 this month");
    // Light and Detailed have Use; Standard, the one in use, says so
    const uses = [...host!.querySelectorAll('[data-settings-row="library-shot-detail"] button')].filter((b) => b.textContent === "Use") as HTMLButtonElement[];
    expect(uses).toHaveLength(2);
    expect(text).toContain("In use");
    await act(async () => uses[1]!.click());
    const field = host!.querySelector('input[aria-label="Monthly budget"]') as HTMLInputElement;
    expect(field.value).toBe("20");
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(field, "35");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => field.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
    expect(patches).toEqual([{ settings: { lookLevel: "detailed" } }, { settings: { lookBudget: 35 } }]);
  });

  it("Timelines list each Gemini model with an hour's cost, 3.8 Flash in use, Antigravity as picture only, and save the one picked", async () => {
    await render(<LibrarySettingsBody library={library} watch={watch} folders={[]} onChange={() => {}} onError={() => {}} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Gemini 3.8 Flash");
    expect(text).toContain("Picture and sound, most moments, about $0.42 an hour of footage");
    expect(text).toContain("Picture and sound, fewer moments, about $0.16 an hour of footage");
    expect(text).toContain("Picture only, no sound");
    const [lite, agy] = [...host!.querySelectorAll('[data-settings-row="library-ai"] button')].filter((b) => b.textContent === "Use") as HTMLButtonElement[];
    await act(async () => lite!.click());
    await act(async () => agy!.click());
    expect(patches).toEqual([{ settings: { timelineModel: "gemini-3.5-flash-lite" } }, { settings: { timelineModel: "antigravity" } }]);
  });

  it("Timelines on Antigravity need it among the AI providers", async () => {
    await render(<LibrarySettingsBody library={{ ...library, settings: { ...library.settings, timelineModel: "antigravity" } }} watch={watch} folders={[]} onChange={() => {}} onError={() => {}} />);
    const needs = [...host!.querySelectorAll("a")].find((x) => x.textContent === "Needs Antigravity");
    expect(needs?.getAttribute("href")).toBe("/settings/providers");
    expect(document.body.textContent).not.toContain("Uses the Gemini API key");
  });

  it("Timelines say once when the Gemini key is on Google's free tier", async () => {
    stopped = "free";
    await render(<LibrarySettingsBody library={library} watch={watch} folders={[]} onChange={() => {}} onError={() => {}} />);
    const text = document.body.textContent ?? "";
    expect(text.split("free tier").length - 1).toBe(1);
    expect(text).toContain("The Gemini key is on Google's free tier, about 20 calls a day; billing in Google AI Studio lifts the limit");
  });

  it("Timelines say once when the Gemini credit ran out", async () => {
    stopped = "credit";
    await render(<LibrarySettingsBody library={library} watch={watch} folders={[]} onChange={() => {}} onError={() => {}} />);
    const text = document.body.textContent ?? "";
    expect(text.split("credit ran out").length - 1).toBe(1);
    expect(text).not.toContain("Uses the Gemini API key");
  });

  it("the upload choice is saved on the library", async () => {
    const changed: LibrarySummary[] = [];
    await render(<UploadSelect library={library} onChange={(l) => changed.push(l)} onError={() => {}} />);
    const select = host!.querySelector('select[aria-label="Upload to the server"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Off", "Proxies only", "Video files and proxies"]);
    await act(async () => {
      select.value = "proxies";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
    expect(patches).toEqual([{ settings: { upload: "proxies" } }]);
    expect(changed.at(-1)?.settings.upload).toBe("proxies");
  });
});
