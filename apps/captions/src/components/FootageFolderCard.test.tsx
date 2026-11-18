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

type Watch = { allowed: boolean; folders: { path: string }[]; missing: number; copyTo?: string };
let watch: Watch;
let postReply: { status: number; body: unknown };
let watchStatus: number;
let calls: { url: string; method: string; body?: string }[];
let root: Root | undefined;
let host: HTMLDivElement | undefined;

const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));

beforeEach(() => {
  watch = { allowed: true, folders: [], missing: 0 };
  postReply = { status: 200, body: { ok: true } };
  watchStatus = 200;
  calls = [];
  localStorage.clear();
  pick.mockReset();
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (init?.method === "POST") return new Response(JSON.stringify(postReply.body), { status: postReply.status });
    if (watchStatus !== 200) return new Response("{}", { status: watchStatus });
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

async function render(onUpload?: () => void, page = false, onChooseFolder?: () => Promise<void>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter>
        <FootageFolderCard libraryId="lib_1" onUpload={onUpload} page={page} onChooseFolder={onChooseFolder} />
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
    expect(JSON.parse(post!.body!)).toEqual({ path: "/Users/owner/Movies/Trip", libraryId: "lib_1" });
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
    postReply = { status: 400, body: { error: "Folder not found on the server: ~/nope" } };
    await render();
    await click("Choose a folder");
    await typeInto("Folder path", "~/nope");
    await click("Add folder");
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ path: "~/nope", libraryId: "lib_1" });
    expect(host!.textContent).toContain("Folder not found on the server: ~/nope");
    expect(card()).not.toBeNull();
  });

  it("on a hosted server the card says the files are on the computer, and offers upload", async () => {
    watch.allowed = false;
    const onUpload = vi.fn();
    await render(onUpload);
    expect(host!.textContent).toContain("Reading a folder needs the Mac app");
    expect(button("Choose a folder")).toBeUndefined();
    await click("Upload files");
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  it("the empty page in the Mac app, server elsewhere: two steps, a folder on this Mac or single files; never \"needs the Mac app\"", async () => {
    watch.allowed = false;
    const onUpload = vi.fn();
    const onChooseFolder = vi.fn(async () => {});
    await render(onUpload, true, onChooseFolder);
    expect(host!.textContent).toContain("Add your footage");
    expect(host!.textContent).not.toContain("needs the Mac app");
    await click("Choose folder");
    expect(onChooseFolder).toHaveBeenCalledTimes(1);
    await click("Upload files");
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  it("in the Library's empty page: no heading, no Skip (a Skip from before is ignored), upload is the page's own button", async () => {
    localStorage.setItem("ct-footage-folder-skipped", "1");
    await render(() => {}, true);
    expect(card()).not.toBeNull();
    expect(host!.textContent).toContain("No clips");
    expect(host!.textContent).not.toContain("Where are your videos?");
    expect(button("Skip")).toBeUndefined();
    expect(button("Upload files")).toBeUndefined();
    expect(button("Choose a folder")).not.toBeUndefined();
  });

  it("a big folder asks in one dialog: copy or keep, what it takes, and how the library sorts it, answered before the folder is added", async () => {
    watch.copyTo = "~/Movies/Creator Toolset/Footage";
    const fetchWatch = globalThis.fetch;
    const order: string[] = [];
    let posted: { copyTo?: string } = {};
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        order.push(url);
        posted = JSON.parse(init.body as string) as { copyTo?: string };
      }
      if (url.includes("/watch/size")) return new Response(JSON.stringify({ files: 40, bytes: 4e9, audio: 0, audioBytes: 0, free: 1e12 }), { status: 200 });
      if (url.includes("/estimate")) return new Response(JSON.stringify({ clips: 40, minutes: 10, seconds: 600, steps: [] }), { status: 200 });
      return fetchWatch(url, init);
    });
    pick.mockResolvedValue("/Users/tiny/Movies/Trip");
    const onOffer = vi.fn(async (o: string) => void order.push(`offer ${o}`));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<MemoryRouter><FootageFolderCard libraryId="lib_1" page offer onOffer={onOffer} /></MemoryRouter>));
    await flush();
    await click("Choose a folder");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Add 40 files from Trip?");
    expect(dialog.textContent).toContain("of footage.");
    const copy = dialog.querySelectorAll('input[name="import-mode"]')[1] as HTMLInputElement; // after Keep in place
    expect(copy.checked).toBe(true); // copying is the default where there is room
    const sort = dialog.querySelectorAll<HTMLInputElement>('input[name="organize"]');
    expect(sort[0]!.checked).toBe(true); // the usual folders, until another is picked
    act(() => sort[1]!.click());
    const add = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Add folder")!;
    act(() => add.click());
    await flush();
    expect(order).toEqual(["offer ai", "/api/library/watch/folder"]);
    expect(posted.copyTo).toBe("~/Movies/Creator Toolset/Footage");
  });

  it("on the AI Editor's page (no offer passed) a big folder still asks how the library sorts it, saved on it", async () => {
    watch.copyTo = "~/Movies/Creator Toolset/Footage";
    const fetchWatch = globalThis.fetch;
    const order: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" || init?.method === "POST") order.push(`${init.method} ${url} ${init.body}`);
      if (url === "/api/library" && !init?.method)
        return new Response(JSON.stringify({ libraries: [{ id: "lib_1", name: "Tiny", storage: "local", settings: {} }] }), { status: 200 });
      if (init?.method === "PATCH") return new Response(JSON.stringify({ id: "lib_1", name: "Tiny", storage: "local", settings: { organize: "ai" } }), { status: 200 });
      if (url.includes("/watch/size")) return new Response(JSON.stringify({ files: 40, bytes: 4e9, audio: 0, audioBytes: 0, free: 1e12 }), { status: 200 });
      if (url.includes("/estimate")) return new Response(JSON.stringify({ clips: 40, minutes: 10, seconds: 600, steps: [] }), { status: 200 });
      return fetchWatch(url, init);
    });
    pick.mockResolvedValue("/Users/tiny/Movies/Trip");
    await render();
    await click("Choose a folder");
    const dialog = document.querySelector('[role="dialog"]')!;
    act(() => dialog.querySelectorAll<HTMLInputElement>('input[name="organize"]')[1]!.click());
    act(() => [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Add folder")!.click());
    await flush();
    expect(order[0]).toContain('PATCH /api/library/lib_1 {"settings":{"organize":"ai","organizeOffered":true}}');
    expect(order[1]).toContain("POST /api/library/watch/folder");
  });

  it("a small folder asks where its files are kept and, the first time, how the library sorts them: no time", async () => {
    watch.copyTo = "~/Movies/Creator Toolset/Footage";
    const fetchWatch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/watch/size")) return new Response(JSON.stringify({ files: 3, bytes: 3e8, audio: 0, audioBytes: 0, free: 1e12 }), { status: 200 });
      return fetchWatch(url, init);
    });
    pick.mockResolvedValue("/Users/tiny/Movies/Trip");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<MemoryRouter><FootageFolderCard libraryId="lib_1" page offer onOffer={async () => {}} /></MemoryRouter>));
    await flush();
    await click("Choose a folder");
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Add 3 files from Trip?");
    expect(dialog.textContent).toContain("Keep in place");
    expect(dialog.textContent).not.toContain("of footage.");
    expect(dialog.querySelectorAll('input[name="organize"]')).toHaveLength(3);
  });

  it("as the Library's first screen for someone who may not see the folders: upload", async () => {
    watchStatus = 404;
    await render(() => {}, true);
    expect(button("Choose a folder")).toBeUndefined();
    expect(button("Upload files")).not.toBeUndefined();
  });
});
