// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddFolderDialog, type Computer } from "./StorageRows";

const here = vi.hoisted(() => ({ device: "", inMac: false }));
vi.mock("@/lib/providers", async (orig) => ({ ...(await orig<typeof import("@/lib/providers")>()), thisMacDevice: () => here.device }));
vi.mock("@/lib/thisMac", async (orig) => ({
  ...(await orig<typeof import("@/lib/thisMac")>()),
  macImports: () => here.inMac,
  chooseFolderOnMac: async () => "/Volumes/Tiny/Trips",
}));

// 11-19 (CEO): adding a folder adds it at once. A big Source media folder on the server's own computer used to ask first
// ("Add 312 files from Trips?", with time and money); now nothing asks, and the row's line says what indexing it takes.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = undefined;
  vi.unstubAllGlobals();
});

describe("Add folder", () => {
  it("in the Mac app, a folder on this Mac is chosen in its panel: no drive list, no path field; nothing chosen says so", async () => {
    const asked: { method: string; body?: string }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      asked.push({ method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
      return new Response(JSON.stringify({ folders: [] }), { status: 200 });
    });
    Object.assign(here, { device: "mac-1", inMac: true });
    const mine = { id: "mac-1", name: "Tiny Mac", owner: "tiny", online: true } as unknown as Computer;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<MemoryRouter><AddFolderDialog open onOpenChange={() => {}} role="footage" devices={[mine]} onChanged={() => {}} /></MemoryRouter>));
    await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
    expect(document.querySelector('input[aria-label="Folder path"]')).toBeNull();
    const form = document.querySelector("form")!;
    await act(async () => void form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(document.body.textContent).toContain("Needs a folder");
    expect(asked.some((a) => a.method === "POST")).toBe(false);
    const choose = [...document.querySelectorAll("button")].find((b) => b.textContent === "Choose folder")!;
    await act(async () => void choose.click());
    expect(document.body.textContent).toContain("/Volumes/Tiny/Trips");
    await act(async () => void form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    for (let i = 0; i < 4; i++) await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
    expect(asked.find((a) => a.method === "POST")?.body).toContain("/Volumes/Tiny/Trips");
    Object.assign(here, { device: "", inMac: false });
  });

  it("opens on the computer the person is at, not the first one the server lists", async () => {
    const asked: { method: string; body?: string }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      asked.push({ method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
      return new Response(JSON.stringify({ folders: [] }), { status: 200 });
    });
    here.device = "mac-2";
    const worker = { id: "mac-1", name: "Worker", owner: "tiny", online: true } as unknown as Computer;
    const mine = { id: "mac-2", name: "Tiny Mac", owner: "tiny", online: true } as unknown as Computer;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<MemoryRouter><AddFolderDialog open onOpenChange={() => {}} role="footage" devices={[worker, mine]} onChanged={() => {}} /></MemoryRouter>));
    await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Folder path"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "/Volumes/Tiny/Trips");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => void input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    for (let i = 0; i < 4; i++) await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
    expect(asked.find((a) => a.method === "POST")?.body).toContain('"host":"mac-2"');
    here.device = "";
  });

  it("a big Source media folder on this server's computer is added at once: no dialog, its size never asked", async () => {
    const asked: { url: string; method: string; body?: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      asked.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
      return new Response(JSON.stringify(url.includes("/watch/size") ? { files: 312, bytes: 3e11 } : { folders: [] }), { status: 200 });
    });
    const onChanged = vi.fn();
    const mac = { id: "mac-1", name: "Tiny Mac", owner: "tiny", online: true } as unknown as Computer;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<MemoryRouter><AddFolderDialog open onOpenChange={() => {}} role="footage" devices={[mac]} here={["mac-1"]} onChanged={onChanged} /></MemoryRouter>));
    await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Folder path"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "/Volumes/Tiny/Trips");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => void input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    for (let i = 0; i < 4; i++) await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
    expect(asked.some((a) => a.url.includes("/watch/size"))).toBe(false);
    expect(asked.find((a) => a.method === "POST")?.body).toContain("/Volumes/Tiny/Trips");
    expect(document.body.textContent).not.toMatch(/Add \\d+ files/);
    expect(onChanged).toHaveBeenCalled();
  });
});
