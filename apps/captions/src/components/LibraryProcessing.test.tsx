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
  it("is one line with a moving bar until opened; opened, it lists the steps and what waits, and stays open next time", async () => {
    const el = await render();
    expect(el.textContent).toBe("Preparing 10 clips · about 2 min left");
    expect(el.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("20");
    // the light along the bar moves (and breathes with reduced motion), whatever the counts do
    expect(el.querySelector('[role="progressbar"] > div:last-child')?.className).toMatch(/motion-safe:animate-\[processing-progress-shimmer.*motion-reduce:animate-pulse/);
    act(() => el.querySelector("button")!.click());
    expect(el.textContent).toContain("Adding clips from Trip");
    expect(el.textContent).toContain("Proxies · C9501");
    expect(el.textContent).toContain("5 AI descriptions need an AI");
    expect(el.textContent).not.toContain("Settings → API keys");
    expect(el.querySelector('a[href="/settings/providers"]')?.textContent).toBe("5 AI descriptions need an AI");
    act(() => root!.unmount());
    root = undefined;
    expect((await render()).textContent).toContain("Proxies");
  });

  it("says what waits by itself when nothing runs: it is why nothing moves", async () => {
    progress = { ...progress, left: 0, clips: 0, share: 0, stages: [] };
    const el = await render();
    expect(el.textContent).toBe("5 AI descriptions need an AI");
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
  });
});
