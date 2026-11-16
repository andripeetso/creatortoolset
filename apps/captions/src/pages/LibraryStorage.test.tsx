// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryStorage } from "@contracts/library";
import { LibraryStorageSettings } from "./LibraryStorage";
import { videoPlace } from "./library/LibrarySettings";

// Storage in the library's settings: where nothing can change there is no choice that does nothing (the rows say where
// the files are, videoPlace); where it can change, the choice is there.

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
  it("a library holding files on a server: no dead choices", async () => {
    const el = await render(local, false);
    expect(el.textContent).toBe("Storage");
    expect(el.querySelectorAll("input, button")).toHaveLength(0);
  });

  it("a library holding files on this computer: its proxies may still go to the cloud, its originals may not", async () => {
    const el = await render(local);
    const radio = (text: string) => [...el.querySelectorAll("label")].find((l) => l.textContent === text)!.querySelector("input")!;
    expect(radio("Off").checked).toBe(true);
    expect(radio("Proxies only").disabled).toBe(false);
    expect(radio("Video files and proxies").disabled).toBe(true);
  });

  it("proxies in a bucket: their choice is the one picked", async () => {
    const el = await render({ ...local, proxies: { kind: "bunny", zone: "tiny-proxies", keysSet: true }, storedBytes: 2e9, days: [] });
    expect(([...el.querySelectorAll("label")].find((l) => l.textContent === "Proxies only")!.querySelector("input") as HTMLInputElement).checked).toBe(true);
  });

  it("an empty library: the choice and Save", async () => {
    const el = await render({ ...local, locked: false });
    expect(el.querySelectorAll('input[type="radio"]').length).toBeGreaterThan(1);
    expect(el.textContent).toContain("Save");
  });
});

describe("where the video files are, in words", () => {
  const none = { onMac: 0, inPlace: 0, stored: { files: 0, bytes: 0 } };
  it("an empty library says where new files go", () => {
    expect(videoPlace(none, { saved: local, onThisComputer: false, onMac: { upload: false } })).toBe("On a Mac, not uploaded");
    expect(videoPlace(none, { saved: local, onThisComputer: false, onMac: { upload: true } })).toBe("Uploaded to the server");
    expect(videoPlace(none, { saved: { ...local, kind: "bunny", zone: "tiny-footage" }, onThisComputer: false, onMac: null })).toBe("Uploaded to Bunny Storage (tiny-footage)");
  });
  it("a library with files says how many are where", () => {
    expect(videoPlace({ onMac: 12, inPlace: 0, stored: { files: 1, bytes: 2.5e9 } }, { saved: local, onThisComputer: false, onMac: { upload: false } })).toBe(
      "12 files on a Mac, not uploaded · 1 file uploaded to the server, 2.5 GB",
    );
  });
});
