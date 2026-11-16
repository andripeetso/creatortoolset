// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary } from "@contracts/library";
import { LibrarySettings } from "@/pages/library/LibrarySettings";
import { UploadSelect } from "@/pages/library/UploadSelect";
import { MediaLibrarySection } from "./MediaLibrarySection";

// Settings → Media Library is the library's own settings sheet, the same sections in both; the upload choice is one select
// whose answer is saved on the library.

// the kit's select as a plain one, so a test can pick a value
vi.mock("@/components/settings/ui", async (orig) => ({
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

const library: LibrarySummary = { id: "lib_1", name: "Tiny Acrobatics", storage: "local", settings: { describe: true, embed: true, proxy: true, upload: "none" } };
const watch = { allowed: false, folders: [], missing: 0 };
const patches: unknown[] = [];

let root: Root | undefined;
let host: HTMLDivElement | undefined;
beforeEach(() => {
  patches.length = 0;
  // the Mac app with the server elsewhere: every section shows
  vi.stubGlobal("webkit", { messageHandlers: { thisMac: { postMessage: async () => ({}) } } });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (init?.method === "PATCH") {
      const b = JSON.parse(String(init.body)) as { settings: object };
      patches.push(b);
      return ok({ ...library, settings: { ...library.settings, ...b.settings } });
    }
    if (url === "/api/library") return ok({ libraries: [library] });
    if (url.endsWith("/watch")) return ok(watch);
    if (url.endsWith("/collections")) return ok({ collections: [] });
    if (url.endsWith("/usage")) return ok({ kind: "local", keysSet: false, serverBucket: false, locked: true, days: [] });
    if (url.endsWith("/space")) return ok({ videos: { onMac: 0, inPlace: 0, stored: { bytes: 0, files: 0 } }, proxies: { bytes: 0, files: 0 }, pictures: { bytes: 0, files: 0 }, models: null });
    if (url.includes("/estimate")) return ok({ steps: [] });
    return ok({});
  });
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = undefined;
  vi.unstubAllGlobals();
});

async function render(el: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter>{el}</MemoryRouter>));
  for (let i = 0; i < 4; i++) await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
}

const SECTIONS = ["Adding files", "Upload", "Sorting", "Storage", "AI", "Redo for every clip"];
const headings = (text: string) => SECTIONS.filter((s) => text.includes(s));

describe("the Media Library's settings", () => {
  it("Settings → Media Library shows the sheet's sections", async () => {
    await render(<MediaLibrarySection />);
    expect(headings(document.body.textContent ?? "")).toEqual(SECTIONS);
  });

  it("the library's own sheet shows the same", async () => {
    await render(<LibrarySettings library={library} watch={watch} folders={[]} onChange={() => {}} onError={() => {}} />);
    act(() => (host!.querySelector('button[title="Library settings"]') as HTMLButtonElement).click());
    for (let i = 0; i < 4; i++) await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
    expect(headings(document.body.textContent ?? "")).toEqual(SECTIONS);
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
