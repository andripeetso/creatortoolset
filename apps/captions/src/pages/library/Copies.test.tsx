// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryCopy } from "@contracts/library";
import { useAuth } from "@/lib/auth";
import { clearLocalCache } from "@/lib/local-cache";
import { copyLines, LibraryCopies } from "./Copies";

// Copies: the owner's folders on their own computers that every clip goes to. Rows say only what is busy or needed;
// Add copy picks a computer, then a folder on it; Stop copying asks nothing.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const copy = (over: Partial<LibraryCopy> = {}): LibraryCopy => ({ id: "cp_1", device: "d1", computer: "Studio Mac", path: "/Volumes/Footage", pending: 0, copying: false, state: "ok", ...over });

const DEVICES = [
  { id: "d1", owner: "sam", name: "Studio Mac", createdAt: 1, online: true, kinds: ["folder-list", "copy"] },
  { id: "d2", owner: "sam", name: "Old Mac", createdAt: 1, online: false, kinds: [] },
  { id: "d3", owner: "ana", name: "Ana's Mac", createdAt: 1, online: true, kinds: ["folder-list"] },
  { id: "d4", owner: "sam", name: "Office Mac", createdAt: 1, online: false, kinds: ["folder-list", "copy"] },
  { id: "d5", owner: "sam", name: "Edit PC", createdAt: 1, online: true, kinds: [], report: { machine: { os: "windows" } } },
];
let devices: unknown[] = DEVICES;
let copies: LibraryCopy[] | "not-owner" = [];
let postFails = false;
/** a folder whose list does not answer until `release()` */
let slow: { path: string; release?: () => void } | null = null;
const calls: Array<{ method: string; url: string; body?: unknown }> = [];
let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  copies = [];
  devices = DEVICES;
  postFails = false;
  slow = null;
  calls.length = 0;
  useAuth.setState({ required: true, me: { username: "sam", role: "admin", cloud: false, off: [] } });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url === "/api/providers")
      return ok({ devices });
    if (url.startsWith("/api/library/lib_1/copies/folders")) {
      const at = new URL(url, "http://x").searchParams.get("path");
      if (slow && at === slow.path) await new Promise<void>((done) => (slow!.release = done));
      return ok({ path: at, folders: at === "/Volumes" ? ["/Volumes/Footage", "/Volumes/Archive"] : [] });
    }
    if (url === "/api/library/lib_1/copies" && method === "GET") return copies === "not-owner" ? ok({ error: "Not found" }, 404) : ok({ copies });
    if (url === "/api/library/lib_1/copies" && method === "POST") return postFails ? ok({}, 500) : ok({ copy: copy({ id: "cp_2", path: (calls.at(-1)!.body as { path: string }).path, state: "new" }) });
    if (method === "DELETE") return ok({ ok: true });
    return ok({});
  });
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = undefined;
  clearLocalCache();
  useAuth.setState({ me: null });
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
};
async function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter>
        <LibraryCopies libraryId="lib_1" />
      </MemoryRouter>,
    ),
  );
  await settle();
}
const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const inDialog = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === label)!;
const submit = () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!;
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await settle();
};

describe("Copies", () => {
  it("says only what is busy or needed", () => {
    const now = new Date(2026, 10, 17, 16, 0).getTime();
    expect(copyLines(copy(), now)).toEqual({ busy: null, needs: [] });
    expect(copyLines(copy({ pending: 12, copying: true }), now).busy).toBe("Copying 12 files");
    const at = new Date(2026, 10, 17, 14, 5);
    const { needs } = copyLines(copy({ state: "reconnect", offlineSince: at.getTime(), waitsFor: "Office Mac" }), now);
    expect(needs[0]).toBe("Needs the folder reconnected");
    // the time today (14:05 in a 24-hour locale), the date on another day
    expect(needs[1]).toBe(`Offline since ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`);
    expect(copyLines(copy({ offlineSince: at.getTime() - 86_400_000 }), now).needs[0]).toBe(`Offline since ${new Date(at.getTime() - 86_400_000).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`);
    expect(needs[2]).toBe("Needs Office Mac online");
    expect(copyLines(copy({ state: "full" }), now).needs).toEqual(["Disk full on the computer"]);
    expect(copyLines(copy({ noOriginal: 1 }), now).needs).toEqual(["No original for 1 file"]);
    expect(copyLines(copy({ noOriginal: 3 }), now).needs).toEqual(["No original for 3 files"]);
    expect(copyLines(copy({ noOriginal: 0 }), now).needs).toEqual([]);
    expect(copyLines(copy({ needsUpload: true }), now).needs).toEqual(["Needs Upload to the server"]);
    for (const line of [...needs, "Disk full on the computer", "No original for 3 files", "Copying 12 files"]) expect(line).not.toMatch(/\.$/);
  });

  it("is left out for anyone but the library's owner", async () => {
    copies = "not-owner";
    await render();
    expect(text()).toBe("");
  });

  it("lists the copies; Stop copying asks nothing; a read-only row has no menu", async () => {
    copies = [copy({ pending: 3, copying: true }), copy({ id: "cp_9", computer: "NAS", path: "/archive", readOnly: true })];
    await render();
    expect(text()).toContain("Studio Mac · /Volumes/Footage");
    expect(text()).toContain("Copying 3 files");
    const menus = document.querySelectorAll('button[aria-label="Copy options"]');
    expect(menus).toHaveLength(1);
    act(() => void menus[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })));
    const items = [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
    expect(items.map((i) => i.textContent)).toEqual(["Stop copying"]); // Show in Finder only inside the Mac app, for this Mac
    await click(items[0]);
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/library/lib_1/copies/cp_1")).toBe(true);
    expect(text()).not.toContain("/Volumes/Footage");
  });

  it("Add copy: a computer of this account's, then a folder on it", async () => {
    await render();
    expect(text()).toContain("No copies");
    await click(button("Add copy"));
    expect(text()).not.toContain("Ana's Mac");
    // computers that cannot take a copy are listed, but cannot be picked, with what they need
    const row = (name: string) => inDialog(name) ?? [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.startsWith(name))!;
    expect(row("Studio Mac").disabled).toBe(false);
    expect(row("Old Mac").disabled).toBe(true);
    expect(row("Old Mac").textContent).toContain("Needs the Mac app updated");
    expect(row("Edit PC").textContent).toContain("Needs an update");
    expect(row("Office Mac").disabled).toBe(true);
    expect(row("Office Mac").textContent).toContain("Needs Office Mac online");
    expect(text()).not.toMatch(/helper|device|Offline/i);
    expect(submit().textContent).toBe("Copy to this folder");
    expect(submit().disabled).toBe(true); // no computer picked

    await click(row("Studio Mac"));
    expect(calls.some((c) => c.url.includes("copies/folders?device=d1&path=%2FVolumes"))).toBe(true);
    expect(inDialog("Computers")).toBeTruthy();
    expect(document.querySelector('nav[aria-label="Folder path"]')?.textContent).toBe("Studio Mac/Volumes");
    expect(submit().disabled).toBe(true); // the Mac's list of disks is not a folder
    expect(document.querySelector('[role="dialog"] .overflow-y-scroll')).toBeTruthy();

    // the list stays on screen, dimmed, while the next folder loads
    slow = { path: "/Volumes/Footage" };
    await click(inDialog("Footage"));
    expect(inDialog("Archive")).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    await act(async () => slow!.release!());
    await settle();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(inDialog("Archive")).toBeUndefined();
    expect(document.querySelector('nav[aria-label="Folder path"]')?.textContent).toBe("Studio Mac/Volumes/Footage");

    expect(submit().disabled).toBe(false);
    await click(submit());
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ device: "d1", path: "/Volumes/Footage" });
    expect(text()).toContain("Studio Mac · /Volumes/Footage");
  });

  it("a failed add says what to do, never a status code", async () => {
    postFails = true;
    await render();
    await click(button("Add copy"));
    await click(inDialog("Studio Mac"));
    await click(inDialog("Footage"));
    await click(submit());
    expect(text()).toContain("Could not reach the server. Try again.");
    expect(text()).not.toContain("500");
  });

  it("no computers: a way to add one", async () => {
    devices = [];
    await render();
    await click(button("Add copy"));
    expect(text()).toContain("No computers yet");
    expect(document.querySelector('[role="dialog"] a')?.getAttribute("href")).toBe("/settings/devices?add=1");
  });
});
