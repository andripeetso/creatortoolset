// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryStorage } from "@contracts/library";
import { LibraryStorageSettings } from "./LibraryStorage";
import { videoFacts, videoPlace } from "./library/LibrarySettings";

// Storage in the library's settings: where nothing can change there is no choice that does nothing; where it can
// change, a choice that needs nothing typed is saved when picked, and a bucket that needs its keys is a form with Save.

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

/** What was saved (each PUT's body). */
const puts: unknown[] = [];

/** `after`: what the server answers a save with. */
async function render(s: LibraryStorage, onThisComputer = true, after: LibraryStorage = s) {
  puts.length = 0;
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method !== "PUT") return new Response(JSON.stringify(s), { status: 200 });
    puts.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(after), { status: 200 });
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<LibraryStorageSettings libraryId="lib_1" onSaved={() => {}} onThisComputer={onThisComputer} />));
  await act(async () => new Promise<void>((done) => setTimeout(done, 0)));
  return host;
}

const local: LibraryStorage = { kind: "local", keysSet: false, serverBucket: false, locked: true, days: [] };
const uploadOf = (el: HTMLElement) => el.querySelector('select[aria-label="Footage upload"]') as HTMLSelectElement;
const saveOf = (el: HTMLElement) => [...el.querySelectorAll("button")].find((b) => b.textContent === "Save");
const choose = (select: HTMLSelectElement, value: string) =>
  act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
/** What the form says is missing (the words are in the page all along, unseen until they apply). */
const needs = (el: HTMLElement) => [...el.querySelectorAll("[data-needs]:not(.invisible)")].map((n) => n.textContent);
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("library storage", () => {
  it("a library holding files on a server: no dead choices, and no empty Uploads section", async () => {
    const el = await render(local, false);
    expect(el.textContent).toBe("");
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

  it("an empty library: the choice, and no Save while there is no form", async () => {
    const el = await render({ ...local, locked: false });
    // replaced (UNIFIED-PRD §4.2): the four upload values stay, Originals only included; the three-word list predates it
    expect([...uploadOf(el).options].map((o) => o.textContent)).toEqual(["Off", "Originals only", "Proxies only", "Originals and proxies"]);
    expect(saveOf(el)).toBeUndefined();
  });

  it("a choice that needs nothing typed is saved when it is picked", async () => {
    const empty = { ...local, locked: false, serverBucket: true };
    const el = await render(empty, true, { ...empty, proxies: { kind: "s3", mode: "server", keysSet: false } });
    expect(el.querySelector('select[aria-label="Location"]')).toBeNull();
    await choose(uploadOf(el), "proxies");
    expect(puts).toEqual([{ kind: "s3", mode: "server", proxies: true }]);
    const where = el.querySelector('select[aria-label="Location"]') as HTMLSelectElement;
    expect(where.value).toBe("server");
    expect([...where.options].map((o) => o.textContent)).toEqual(["The server's bucket", "Bunny Storage", "Amazon S3 or Cloudflare R2"]);
    expect(el.querySelectorAll('input[type="radio"], select:not([aria-label])')).toHaveLength(0);
    expect(saveOf(el)).toBeUndefined();
  });

  it("a bucket that needs its key is a form with Save: never off, it names what is missing, then saves the choice with the key", async () => {
    const el = await render({ ...local, locked: false });
    await choose(uploadOf(el), "proxies");
    // nothing is saved until the form is
    expect(puts).toEqual([]);
    const save = saveOf(el)!;
    expect(save.disabled).toBe(false);
    expect(needs(el)).toEqual([]);
    await act(async () => save.click());
    expect(puts).toEqual([]);
    expect(needs(el)).toEqual(["Needs a Bunny API key"]);
    expect(saveOf(el)!.disabled).toBe(false);
    type(el.querySelector('input[aria-label="Bunny API key"]')!, "tiny-key");
    expect(needs(el)).toEqual([]);
    await act(async () => saveOf(el)!.click());
    expect(puts).toEqual([{ kind: "bunny", apiKey: "tiny-key", region: "DE", proxies: true }]);
  });

  it("an own bucket's form: an on/off choice is a checkbox, and saved keys may stay empty", async () => {
    const own: LibraryStorage = { ...local, kind: "s3", mode: "own", bucket: "tiny-footage", endpoint: "", region: "", keysSet: true };
    const el = await render(own);
    expect(el.querySelector('[role="switch"]')).toBeNull();
    expect(el.querySelector('[role="checkbox"][aria-label="Path-style URLs"]')).toBeTruthy();
    await act(async () => saveOf(el)!.click());
    expect(needs(el)).toEqual([]);
    expect(puts).toEqual([{ kind: "s3", mode: "own", endpoint: "", region: "", bucket: "tiny-footage", pathStyle: false }]);
  });
});

describe("where the video files are, in words", () => {
  const none = { onMac: 0, inPlace: 0, stored: { files: 0, bytes: 0 } };
  it("an empty library says where new files go", () => {
    expect(videoPlace(none, { saved: local, onThisComputer: false, onMac: { upload: false } })).toBe("On a Mac, not uploaded");
    expect(videoPlace(none, { saved: local, onThisComputer: false, onMac: { upload: true } })).toBe("Uploaded to the server");
    expect(videoPlace(none, { saved: { ...local, kind: "bunny", zone: "tiny-footage" }, onThisComputer: false, onMac: null })).toBe("Uploaded to Bunny Storage (tiny-footage)");
  });
  it("the Upload row says it only where its own sentence does not: files to count, or a bucket to name", () => {
    const at = { saved: local, onThisComputer: true, onMac: null };
    expect(videoFacts(none, at)).toBeUndefined();
    expect(videoFacts({ ...none, inPlace: 12 }, at)).toBe("12 files on this computer");
    expect(videoFacts(none, { ...at, saved: { ...local, kind: "bunny", zone: "tiny-footage" } })).toBe("Uploaded to Bunny Storage (tiny-footage)");
  });
  it("a library with files says how many are where", () => {
    expect(videoPlace({ onMac: 12, inPlace: 0, stored: { files: 1, bytes: 2.5e9 } }, { saved: local, onThisComputer: false, onMac: { upload: false } })).toBe(
      "12 files on a Mac, not uploaded · 1 file uploaded to the server, 2.5 GB",
    );
  });
});
