// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryStorage } from "@contracts/library";
import { LibraryStorageSettings } from "./LibraryStorage";

// Storage in the library's settings: where nothing can change it says where the files are kept in one line, with no
// choice that does nothing; where it can change, the choice is there.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = undefined;
  vi.unstubAllGlobals();
});

async function render(s: LibraryStorage, onThisComputer = true) {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(s), { status: 200 }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<LibraryStorageSettings libraryId="lib_1" onSaved={() => {}} onThisComputer={onThisComputer} />));
  await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
  return host;
}

const local: LibraryStorage = { kind: "local", keysSet: false, serverBucket: false, locked: true, days: [] };

describe("library storage", () => {
  it("a library holding files on a server: one plain line, no dead choices", async () => {
    const el = await render(local, false);
    expect(el.textContent).toBe("StorageKept on this server's disk");
    expect(el.querySelectorAll("input, button")).toHaveLength(0);
  });

  it("a library holding files on this computer: its proxies may still go to the cloud, its originals may not", async () => {
    const el = await render(local);
    const radio = (text: string) => [...el.querySelectorAll("label")].find((l) => l.textContent === text)!.querySelector("input")!;
    expect(radio("Nothing").checked).toBe(true);
    expect(radio("Proxies only").disabled).toBe(false);
    expect(radio("Originals").disabled).toBe(true);
  });

  it("proxies in a bucket say where they are", async () => {
    const el = await render({ ...local, proxies: { kind: "bunny", zone: "tiny-proxies", keysSet: true }, storedBytes: 2e9, days: [] });
    expect(el.textContent).toContain("Proxies in Bunny Storage (tiny-proxies) · 2.0 GB");
    expect(([...el.querySelectorAll("label")].find((l) => l.textContent === "Proxies only")!.querySelector("input") as HTMLInputElement).checked).toBe(true);
  });

  it("an empty library: the choice and Save", async () => {
    const el = await render({ ...local, locked: false });
    expect(el.querySelectorAll('input[type="radio"]').length).toBeGreaterThan(1);
    expect(el.textContent).toContain("Save");
  });
});
