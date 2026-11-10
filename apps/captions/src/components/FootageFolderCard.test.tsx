// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FootageFolderCard } from "./FootageFolderCard";

// "Where are your videos?": the card adds the folder the person picks to the watch list, remembers Skip, and never
// calls a route that walks the disk. The Mac app's picker and the server are stubbed.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pick = vi.fn<() => Promise<string | null | undefined>>();
vi.mock("@/lib/thisMac", () => ({ chooseFolderOnMac: () => pick() }));

type Watch = { allowed: boolean; folders: { path: string }[]; missing: number };
let watch: Watch;
let postReply: { status: number; body: unknown };
let calls: { url: string; method: string; body?: string }[];
let root: Root | undefined;
let host: HTMLDivElement | undefined;

const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));

beforeEach(() => {
  watch = { allowed: true, folders: [], missing: 0 };
  postReply = { status: 200, body: { ok: true } };
  calls = [];
  localStorage.clear();
  pick.mockReset();
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (init?.method === "POST") return new Response(JSON.stringify(postReply.body), { status: postReply.status });
    return new Response(JSON.stringify(watch), { status: 200 });
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

async function render(onUpload?: () => void) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter>
        <FootageFolderCard libraryId="lib_1" onUpload={onUpload} />
      </MemoryRouter>,
    );
  });
  await flush();
}

const card = () => host!.querySelector('[aria-label="Footage folder"]');
const button = (label: string) => [...host!.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = async (label: string) => {
  const b = button(label);
  if (!b) throw new Error(`no button ${label}`);
  act(() => b.click());
  await flush();
};
const typeInto = async (label: string, value: string) => {
  const input = host!.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
};

describe("Where are your videos?", () => {
  it("the Mac app's picker adds the chosen folder to the Library's watch list, and the card goes", async () => {
    pick.mockResolvedValue("/Users/owner/Movies/Trip");
    await render();
    expect(card()).not.toBeNull();
    await click("Choose a folder");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/library/watch/folder");
    expect(JSON.parse(post!.body!)).toEqual({ path: "/Users/owner/Movies/Trip" });
    expect(card()).toBeNull();
  });

  it("a cancelled picker adds nothing and leaves the card", async () => {
    pick.mockResolvedValue(null);
    await render();
    await click("Choose a folder");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(card()).not.toBeNull();
  });

  it("never calls a route that walks the disk", async () => {
    pick.mockResolvedValue("/Users/owner/Movies/Trip");
    await render();
    await click("Choose a folder");
    expect(calls.some((c) => c.url.includes("/folders/scan"))).toBe(false);
  });

  it("Skip is remembered: the card does not come back on the next visit", async () => {
    await render();
    await click("Skip");
    expect(card()).toBeNull();
    act(() => root!.unmount());
    host!.remove();
    calls = [];
    await render();
    expect(card()).toBeNull();
    expect(calls).toHaveLength(0); // nothing is even asked
  });

  it("a folder that is already on the watch list means no card", async () => {
    watch.folders = [{ path: "/Users/owner/Movies/Trip" }];
    await render();
    expect(card()).toBeNull();
  });

  it("in a browser on this computer, a typed path is checked by the server and a refusal stays on the card", async () => {
    pick.mockResolvedValue(undefined); // no Mac app: no picker
    postReply = { status: 400, body: { error: "No such folder on the server: ~/nope" } };
    await render();
    await click("Choose a folder");
    await typeInto("Folder path", "~/nope");
    await click("Check folder");
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ path: "~/nope" });
    expect(host!.textContent).toContain("No such folder on the server: ~/nope");
    expect(card()).not.toBeNull();
  });

  it("on a hosted server the card says the files are on the computer, and offers upload", async () => {
    watch.allowed = false;
    const onUpload = vi.fn();
    await render(onUpload);
    expect(host!.textContent).toContain("Your videos are on your computer");
    expect(button("Choose a folder")).toBeUndefined();
    await click("Upload files");
    expect(onUpload).toHaveBeenCalledTimes(1);
  });
});
