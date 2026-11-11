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

async function render(s: LibraryStorage) {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(s), { status: 200 }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<LibraryStorageSettings libraryId="lib_1" onSaved={() => {}} onThisComputer />));
  await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
  return host;
}

const local: LibraryStorage = { kind: "local", keysSet: false, serverBucket: false, locked: true, days: [] };

describe("library storage", () => {
  it("a library holding files on this computer: one plain line, no dead choices", async () => {
    const el = await render(local);
    expect(el.textContent).toBe("StorageKept on this computer's disk");
    expect(el.querySelectorAll("input, button")).toHaveLength(0);
  });

  it("an empty library: the choice and Save", async () => {
    const el = await render({ ...local, locked: false });
    expect(el.querySelectorAll('input[type="radio"]').length).toBeGreaterThan(1);
    expect(el.textContent).toContain("Save");
  });
});
