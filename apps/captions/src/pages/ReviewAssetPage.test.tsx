// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewView } from "@/lib/review";
import { useAuth, type Me } from "@/lib/auth";

// The Review page in a DOM, with a test plug-in whose panel sends a play plan that skips a span: the page's player
// must skip it as it plays. The server calls are replaced by one fixed view; the plug-in is the only slot.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ view: null as unknown }));

vi.mock("@/lib/local-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local-cache")>()),
  useCachedLoad: () => ({ data: h.view, set: () => {}, refresh: async () => {} }),
}));

vi.mock("@/plugins.gen", async () => {
  const { createElement, useEffect } = await vi.importActual<typeof import("react")>("react");
  // a panel that sends one plan on mount: frames 50 to 75 are cut (at 25 fps, 2 s to 3 s)
  function TinyPanel({ preview }: { preview: { setPlan: (p: unknown) => void } }) {
    useEffect(() => {
      preview.setPlan({ fps: 25, skips: [[50, 75]], mutes: [], holds: [], cards: [], frames: [] });
    }, [preview]);
    return createElement("p", null, "Tiny panel");
  }
  return { webPlugins: [{ id: "tiny", review: { panels: [{ id: "edits", panel: TinyPanel }] } }] };
});

// imported after the mocks
const { default: ReviewAssetPage } = await import("./ReviewAssetPage");

const version = {
  n: 1,
  name: "Cut",
  duration: 8,
  fps: 25,
  width: 1080,
  height: 1920,
  status: "ready" as const,
  progress: 100,
  bytes: 1000,
  createdAt: 0,
};

const view: ReviewView = {
  asset: {
    id: "a1",
    name: "Asset",
    approval: { status: "none" },
    versions: [version],
    download: false,
    createdAt: 0,
  },
  comments: [],
  manage: true,
  user: "owner",
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("the Review page's player follows a plug-in's play plan", () => {
  it("skips the span the plan names as the playhead reaches it", async () => {
    useAuth.setState({ me: { username: "owner", role: "admin", cloud: false, off: [] } as Me });
    h.view = view;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={["/review/a1"]}>
          <Routes>
            <Route path="/review/:assetId" element={<ReviewAssetPage />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await act(async () => {});

    const video = host.querySelector("video") as HTMLVideoElement | null;
    expect(video).not.toBeNull();
    expect(host.textContent).toContain("Tiny panel");

    // play, then the playhead arrives at frame 51 (inside the span): the page's follower jumps it to frame 75
    await act(async () => {
      video!.dispatchEvent(new Event("play"));
    });
    await act(async () => {
      video!.currentTime = 51 / 25;
      video!.dispatchEvent(new Event("seeked"));
    });
    expect(video!.currentTime).toBe(75 / 25);
  });
});
