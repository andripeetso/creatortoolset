// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryProgress, WatchStatus } from "@contracts/library";
import { KeepChoice, LibraryProgressBar, useBigFolder } from "./LibraryProcessing";

// The library's processing: one line and a moving bar by default, the steps when the person opens it (remembered), and
// what waits for them in a few words, said by itself when nothing else runs.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let progress: LibraryProgress;
const watch: WatchStatus = { allowed: true, folders: [{ path: "/Volumes/Card/Trip", mode: "reference", addedBy: "me", found: true, files: 10, adding: 7, imported: 3 }], missing: 0 };
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));

beforeEach(() => {
  localStorage.clear();
  progress = {
    done: 4, left: 30, clips: 10, share: 0.2, seconds: 90,
    waiting: [{ step: "describe", count: 5, missing: "No AI for your account: add one in Settings → Providers, or your Anthropic key in Settings → API keys" }],
    stages: [{ kind: "thumb", done: 3, of: 3, failed: 0 }, { kind: "proxy", done: 1, of: 3, failed: 0, now: "C9501" }],
  };
  vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(url.endsWith("/watch") ? watch : progress), { status: 200 }));
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = undefined;
  vi.unstubAllGlobals();
});

async function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MemoryRouter><LibraryProgressBar libraryId={`lib_${Math.random()}`} /></MemoryRouter>));
  await flush();
  await flush();
  return host;
}

describe("the library's processing line", () => {
  it("is one line with a moving bar until opened; opened, it lists the steps and what waits, and stays open next time", async () => {
    const el = await render();
    expect(el.textContent).toBe("Preparing 10 clips · about 2 min left");
    expect(el.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("20");
    // the light along the bar moves (and breathes with reduced motion), whatever the counts do
    expect(el.querySelector('[role="progressbar"] > div:last-child')?.className).toMatch(/motion-safe:animate-\[processing-progress-shimmer.*motion-reduce:animate-pulse/);
    act(() => el.querySelector("button")!.click());
    expect(el.textContent).toContain("Adding clips from Trip");
    expect(el.textContent).toContain("Proxies · C9501");
    expect(el.textContent).toContain("5 descriptions need an AI provider");
    expect(el.textContent).not.toContain("Settings → API keys");
    expect(el.querySelector('a[href="/settings/providers"]')?.textContent).toBe("5 descriptions need an AI provider");
    act(() => root!.unmount());
    root = undefined;
    expect((await render()).textContent).toContain("Proxies");
  });

  it("says what waits by itself when nothing runs: it is why nothing moves", async () => {
    progress = { ...progress, left: 0, clips: 0, share: 0, stages: [] };
    const el = await render();
    expect(el.textContent).toBe("5 descriptions need an AI provider");
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("leaves out what waits for one of the person's computers: the library page shows nothing for it", async () => {
    progress = { ...progress, left: 0, clips: 0, share: 0, stages: [], waiting: [{ step: "look", count: 14, missing: "Video work is off on this server", away: true }] };
    expect((await render()).textContent).toBe("");
  });

  const held: LibraryProgress["waiting"] = [
    { step: "files", count: 6, missing: "", away: true, wait: "stuck", reason: "Mac Studio hasn't started on these", href: "/settings/devices", mine: true, device: "mac" },
    { step: "look", count: 14, missing: "", away: true, wait: "offline", reason: "Linux box is offline", mine: true, device: "linux", devices: ["linux", "mac"] },
    { step: "look", count: 2, missing: "", away: true, wait: "cannot", reason: "Not made on computers yet", mine: true },
    { step: "files", count: 1, missing: "", away: true, wait: "needs", reason: "Mac Studio is Off in Load balancing", href: "/settings/devices", mine: true, device: "mac" },
    { step: "files", count: 3, missing: "", away: true, wait: "needs", reason: "Your owner keeps its files on their computers", mine: false },
  ];

  it("says over the clips only what needs the person and work no computer has taken; the status window says every wait", async () => {
    progress = { ...progress, left: 0, clips: 0, share: 0, stages: [], waiting: held };
    const el = await render();
    expect([...el.querySelectorAll("section > div")].map((d) => d.textContent)).toEqual([
      "6 files · Mac Studio hasn't started on these",
      "1 file · Mac Studio is Off in Load balancing",
    ]);
    expect(el.querySelector("section > div")?.className).toContain("text-red-600");
    expect(el.querySelector('a[href="/settings/devices"]')?.textContent).toBe("6 files · Mac Studio hasn't started on these");
    act(() => root!.unmount());
    root = undefined;
    host!.remove();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<MemoryRouter><LibraryProgressBar libraryId={`lib_${Math.random()}`} all /></MemoryRouter>));
    await flush();
    await flush();
    expect([...host.querySelectorAll("section > div")].map((d) => d.textContent)).toEqual([
      "6 files · Mac Studio hasn't started on these",
      "14 shot descriptions · Linux box is offline",
      "2 shot descriptions · Not made on computers yet",
      "1 file · Mac Studio is Off in Load balancing",
      "3 files · Your owner keeps its files on their computers",
    ]);
  });
});

describe("where a chosen folder's files are kept", () => {
  async function choice(free: number) {
    const picked: (string | undefined)[] = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<KeepChoice libraryId="lib_1" folder="/Volumes/Card/Trip" bytes={5e9} to="~/Movies/Creator Toolset/Footage" free={free} onChange={(c) => picked.push(c)} />));
    await flush();
    const radio = (text: string) => [...host!.querySelectorAll("label")].find((l) => l.textContent?.startsWith(text))!.querySelector("input")!;
    return { picked, copy: radio("Copy into the library"), keep: radio("Keep in place") };
  }

  it("copies into the library folder when there is room", async () => {
    const { picked, copy } = await choice(50e9);
    expect(copy.checked).toBe(true);
    expect(picked.at(-1)).toBe("~/Movies/Creator Toolset/Footage");
  });

  it("keeps them where they are when the copy would not fit, and says how much room there is", async () => {
    const { picked, copy, keep } = await choice(2e9);
    expect(copy.disabled).toBe(true);
    expect(keep.checked).toBe(true);
    expect(picked.at(-1)).toBeUndefined();
    expect(host!.textContent).toContain("Not enough space there: 2.0 GB free");
  });
});

describe("folders dropped together", () => {
  it("are asked one after another, and each is added", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/library") return new Response(JSON.stringify({ libraries: [{ id: "lib_1", name: "Tiny", storage: "local", settings: { organize: "own" } }] }), { status: 200 });
      if (url.includes("/watch/size")) return new Response(JSON.stringify({ files: 3, bytes: 3e8, audio: 0, audioBytes: 0, free: 1e12 }), { status: 200 });
      return new Response(JSON.stringify({ ...watch, copyTo: "~/Movies/Creator Toolset/Footage" }), { status: 200 });
    });
    const added: string[] = [];
    let big!: ReturnType<typeof useBigFolder>;
    function Host() {
      big = useBigFolder();
      return <>{big.dialog}</>;
    }
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<MemoryRouter><Host /></MemoryRouter>));
    await act(async () => {
      await Promise.all(["/Volumes/Card/Trip", "/Volumes/Card/Beach"].map((p) => big.check(p, () => void added.push(p), { libraryId: "lib_1", offerCopy: true })));
    });
    for (const name of ["Trip", "Beach"]) {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      expect(dialogs).toHaveLength(1);
      expect(dialogs[0].textContent).toContain(`Add 3 files from ${name}?`);
      act(() => [...dialogs[0].querySelectorAll("button")].find((b) => b.textContent === "Add folder")!.click());
      await flush();
    }
    expect(added).toEqual(["/Volumes/Card/Trip", "/Volumes/Card/Beach"]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("what waits on them (loose files dropped beside) comes once the last is answered, or closed; at once with none open", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/library") return new Response(JSON.stringify({ libraries: [{ id: "lib_1", name: "Tiny", storage: "local", settings: { organize: "own" } }] }), { status: 200 });
      if (url.includes("/watch/size")) return new Response(JSON.stringify({ files: 3, bytes: 3e8, audio: 0, audioBytes: 0, free: 1e12 }), { status: 200 });
      return new Response(JSON.stringify({ ...watch, copyTo: "~/Movies/Creator Toolset/Footage" }), { status: 200 });
    });
    const done: string[] = [];
    let big!: ReturnType<typeof useBigFolder>;
    function Host() {
      big = useBigFolder();
      return <>{big.dialog}</>;
    }
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<MemoryRouter><Host /></MemoryRouter>));
    big.after(() => void done.push("none open"));
    expect(done).toEqual(["none open"]);
    await act(async () => {
      await Promise.all(["/Volumes/Card/Trip", "/Volumes/Card/Beach"].map((p) => big.check(p, () => void done.push(p), { libraryId: "lib_1", offerCopy: true })));
    });
    big.after(() => void done.push("loose files"));
    act(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === "Add folder")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(done).toEqual(["none open", "/Volumes/Card/Trip"]); // one dialog still open: they wait
    act(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === "Cancel")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    expect(done).toEqual(["none open", "/Volumes/Card/Trip", "loose files"]);
  });
});
