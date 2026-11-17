// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryCopy } from "@contracts/library";
import { useAuth } from "@/lib/auth";
import { clearLocalCache } from "@/lib/local-cache";
import { copyLines, LibraryCopies } from "./Copies";

// Copies: the owner's folders on their own computers that every clip goes to. Rows say only what is busy or needed;
// Add copy picks a computer, then a folder on it; Stop copying asks nothing.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const copy = (over: Partial<LibraryCopy> = {}): LibraryCopy => ({ id: "cp_1", device: "d1", computer: "Studio Mac", path: "/Volumes/Footage", pending: 0, copying: false, state: "ok", ...over });

let copies: LibraryCopy[] | "not-owner" = [];
const calls: Array<{ method: string; url: string; body?: unknown }> = [];
let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  copies = [];
  calls.length = 0;
  useAuth.setState({ required: true, me: { username: "sam", role: "admin", cloud: false, off: [] } });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url === "/api/providers")
      return ok({
        devices: [
          { id: "d1", owner: "sam", name: "Studio Mac", createdAt: 1, online: true, kinds: ["folder-list", "copy"] },
          { id: "d2", owner: "sam", name: "Old Mac", createdAt: 1, online: false, kinds: [] },
          { id: "d3", owner: "ana", name: "Ana's Mac", createdAt: 1, online: true, kinds: ["folder-list"] },
        ],
      });
    if (url.startsWith("/api/library/lib_1/copies/folders")) {
      const at = new URL(url, "http://x").searchParams.get("path");
      return ok({ path: at, folders: at === "/Volumes" ? ["/Volumes/Footage", "/Volumes/Archive"] : [] });
    }
    if (url === "/api/library/lib_1/copies" && method === "GET") return copies === "not-owner" ? ok({ error: "Not found" }, 404) : ok({ copies });
    if (url === "/api/library/lib_1/copies" && method === "POST") return ok({ copy: copy({ id: "cp_2", path: (calls.at(-1)!.body as { path: string }).path, state: "new" }) });
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
  act(() => root!.render(<LibraryCopies libraryId="lib_1" />));
  await settle();
}
const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
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
    expect(copyLines(copy({ state: "full" }), now).needs).toEqual(["Disk full"]);
    for (const line of [...needs, "Disk full", "Copying 12 files"]) expect(line).not.toMatch(/\.$/);
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
    const menus = document.querySelectorAll('button[aria-label="Copy"]');
    expect(menus).toHaveLength(1);
    act(() => void menus[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })));
    const items = [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
    expect(items.map((i) => i.textContent)).toEqual(["Stop copying"]); // Show in Finder only inside the Mac app, for this Mac
    await click(items[0]);
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/library/lib_1/copies/cp_1")).toBe(true);
    expect(text()).not.toContain("/Volumes/Footage");
  });

  it("Add copy: a computer of this account's that lists folders, then a folder on it", async () => {
    await render();
    expect(text()).toContain("No copies");
    await click(button("Add copy"));
    expect(text()).toContain("Studio Mac");
    expect(text()).not.toContain("Ana's Mac");
    expect(text()).not.toContain("Old Mac");
    await click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.includes("Studio Mac"))!);
    expect(calls.some((c) => c.url.includes("copies/folders?device=d1&path=%2FVolumes"))).toBe(true);
    expect([...document.querySelectorAll('[role="dialog"] button')].map((b) => b.textContent)).toEqual(expect.arrayContaining(["Up", "Archive", "Footage"]));
    await click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === "Footage")!);
    await click([...document.querySelectorAll('[role="dialog"] button[type="submit"]')][0]);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ device: "d1", path: "/Volumes/Footage" });
    expect(text()).toContain("Studio Mac · /Volumes/Footage");
  });
});
