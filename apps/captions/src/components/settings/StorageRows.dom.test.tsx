// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageFolder } from "@contracts/storage";
import { Storage, type Computer } from "./StorageRows";

// Settings → Folders in the Mac app's window: this Mac's folders waiting for an OK, or not found where they were
const mac = { id: "dev_1", name: "Tiny Studio Mac", owner: "sam", online: true } as unknown as Computer;
const shoots = (state: StorageFolder["folderState"]): StorageFolder => ({
  id: "f_1", role: "footage", name: "Shoots", origin: { host: "dev_1", path: "/Volumes/Tiny Drive/Shoots" }, make: false, createdAt: 0, reach: {}, folderState: state,
});
const flush = () => act(() => new Promise<void>((done) => setTimeout(done, 0)));
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label);

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  delete document.documentElement.dataset.macDevice;
  delete document.documentElement.dataset.macImport;
});

async function show(folder: StorageFolder, devices = [mac]) {
  document.documentElement.dataset.macDevice = "dev_1";
  document.documentElement.dataset.macImport = "1";
  const mediaAccess = { postMessage: vi.fn(async () => ({ granted: true })) };
  const thisMac = { postMessage: vi.fn(async () => ({ path: "/Volumes/Tiny Drive/Shoots 2026" })) };
  vi.stubGlobal("webkit", { messageHandlers: { mediaAccess, thisMac } });
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ folders: [] }) }));
  vi.stubGlobal("fetch", fetch);
  const onChanged = vi.fn();
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<Storage devices={devices} storage={{ folders: [folder], serverDisks: [] }} onChanged={onChanged} />));
  return { mediaAccess, thisMac, fetch, onChanged };
}

describe("a folder on this Mac", () => {
  it("Needs your OK: Allow on this Mac asks the app only when pressed", async () => {
    const { mediaAccess, onChanged } = await show(shoots("needs_ok"));
    expect(document.body.textContent).toContain("Needs your OK");
    expect(mediaAccess.postMessage).not.toHaveBeenCalled();
    await act(async () => button("Allow on this Mac")!.click());
    await flush();
    expect(mediaAccess.postMessage).toHaveBeenCalledWith({ folderGrant: { path: "/Volumes/Tiny Drive/Shoots", folder: "f_1" } });
    expect(onChanged).toHaveBeenCalled();
  });

  it("Folder not found: Re-point opens the Mac's picker on a press and sends the new path", async () => {
    const { thisMac, fetch } = await show(shoots("not_found"));
    expect(document.body.textContent).toContain("Folder not found, re-point?");
    expect(thisMac.postMessage).not.toHaveBeenCalled();
    await act(async () => button("Re-point")!.click());
    await flush();
    expect(thisMac.postMessage).toHaveBeenCalledWith("folder");
    expect(fetch).toHaveBeenCalledWith("/api/devices/storage/folders/f_1/re-point", expect.objectContaining({ method: "POST", body: JSON.stringify({ path: "/Volumes/Tiny Drive/Shoots 2026" }) }));
  });

  it("a folder on another computer has no buttons and names that computer", async () => {
    const laptop = { id: "dev_2", name: "Tiny Laptop", owner: "sam", online: true } as unknown as Computer;
    const { mediaAccess } = await show({ ...shoots("needs_ok"), origin: { host: "dev_2", path: "/Volumes/Tiny Drive/Shoots" } }, [mac, laptop]);
    expect(document.body.textContent).toContain("Needs your OK");
    expect(button("Allow on this Mac")).toBeUndefined();
    expect(mediaAccess.postMessage).not.toHaveBeenCalled();
  });
});
