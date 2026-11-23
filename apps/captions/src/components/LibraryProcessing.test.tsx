// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryProgress, WatchStatus } from "@contracts/library";
import { LibraryProgressBar } from "./LibraryProcessing";

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
  it("Stop takes every kind's queued work off the queue, the ones Library status has a Cancel for", async () => {
    const posts: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(url);
      return new Response(JSON.stringify(url.endsWith("/stop") ? { files: 1 } : url.endsWith("/watch") ? watch : progress), { status: 200 });
    });
    const el = await render();
    const stop = [...el.querySelectorAll("button")].find((b) => b.textContent === "Stop")!;
    act(() => stop.click());
    await flush();
    expect(posts.map((u) => u.split("/made/")[1]).sort()).toEqual(["describe/stop", "embed/stop", "fingerprint/stop", "look/stop", "pictures/stop", "proxy/stop", "sprite/stop", "timeline/stop", "transcribe/stop"]);
  });

  it("is one line with a moving bar until opened; opened, it lists the steps and what waits, and stays open next time", async () => {
    const el = await render();
    expect(el.textContent).toBe("Preparing 10 clips · about 2 min leftStop");
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
    { step: "look", count: 2, missing: "", away: true, wait: "cannot", reason: "Video work is off on this server, and no computer of yours can make these", mine: true },
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
  });
});

// replaced (CEO 11-19: no confirm dialog on adding media or a folder; organize offer dropped, Organization is chosen in setup
// step 4 and Library settings only): "folders dropped together" and "a folder dropped in place" tested useBigFolder's
// dialog queue, which is gone with it.
