// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryStorage } from "@contracts/library";
import { LibraryStorageSettings } from "./LibraryStorage";
import { videoPlace } from "./library/LibrarySettings";

// Storage in the library's settings: where nothing can change there is no choice that does nothing (the rows say where
// the files are, videoPlace); where it can change, the choice is there.

// the kit's select as a plain one, so a test can read its options
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
const uploadOf = (el: HTMLElement) => el.querySelector('select[aria-label="Upload to the server"]') as HTMLSelectElement;

describe("library storage", () => {
  it("a library holding files on a server: no dead choices", async () => {
    const el = await render(local, false);
    expect(el.textContent).toBe("Storage");
    expect(el.querySelectorAll("input, button, select")).toHaveLength(0);
  });

  it("a library holding files on this computer: its proxies may still go to the cloud, its originals may not", async () => {
    const upload = uploadOf(await render(local));
    expect(upload.value).toBe("none");
    // what cannot be chosen is not offered
    expect([...upload.options].map((o) => o.textContent)).toEqual(["Off", "Proxies only"]);
  });

  it("proxies in a bucket: their choice is the one picked", async () => {
    const el = await render({ ...local, proxies: { kind: "bunny", zone: "tiny-proxies", keysSet: true }, storedBytes: 2e9, days: [] });
    expect(uploadOf(el).value).toBe("proxies");
  });

  it("an empty library: the choice and Save", async () => {
    const el = await render({ ...local, locked: false });
    expect([...uploadOf(el).options].map((o) => o.textContent)).toEqual(["Off", "Proxies only", "Video files and proxies"]);
    expect(el.textContent).toContain("Save");
  });

  it("the cloud copy and where it goes are the Settings rows, one control for the upload choice", async () => {
    const el = await render({ ...local, locked: false, serverBucket: true });
    expect(el.querySelector('select[aria-label="Location"]')).toBeNull();
    await act(async () => {
      uploadOf(el).value = "proxies";
      uploadOf(el).dispatchEvent(new Event("change", { bubbles: true }));
    });
    const where = el.querySelector('select[aria-label="Location"]') as HTMLSelectElement;
    expect(where.value).toBe("server");
    expect([...where.options].map((o) => o.textContent)).toEqual(["The server's bucket", "Bunny Storage", "Amazon S3 or Cloudflare R2"]);
    expect(el.querySelectorAll('input[type="radio"], select:not([aria-label])')).toHaveLength(0);
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
