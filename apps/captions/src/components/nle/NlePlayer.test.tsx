// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withKeys, type NleTimeline } from "@/lib/nle/model";
import { NlePlayer, whyNot, type NleFile } from "./NlePlayer";

afterEach(() => vi.unstubAllGlobals());

// a Tiny Acrobatics cut of one shot whose file is on a drive that isn't connected
const tl: NleTimeline = withKeys({
  timeline: { fps: 25, width: 1080, height: 1920 },
  sources: { a: { fps: 25 } },
  tracks: { V1: { items: [{ src: "a", rec: 0, len: 50, in: 0 }] } },
} as unknown as NleTimeline);

describe("a shot whose file doesn't play here", () => {
  it("draws the line it was given (the drive away) on its frame, not File not found here", async () => {
    const texts: string[] = [];
    const ctx = new Proxy({} as Record<string | symbol, unknown>, {
      get: (t, k) => (k === "fillText" ? (s: string) => void texts.push(s) : k in t ? t[k] : () => {}),
      set: (t, k, v) => ((t[k] = v), true),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const urlOf = (): NleFile => ({ url: "", why: "Tiny Drive isn't connected" });
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(<NlePlayer tl={tl} time={0} playing={false} rate={1} urlOf={urlOf} nameOf={() => "desktop.mp4"} />));
    await act(() => new Promise((done) => setTimeout(done, 50)));
    expect(texts).toContain("Media Offline");
    expect(texts).toContain("Tiny Drive isn't connected");
    expect(texts).not.toContain("File not found here");
    act(() => root.unmount());
  });

  it("a Mac file that failed to load asks the app why: 409 disk_away names the drive", async () => {
    vi.stubGlobal("fetch", async () => ({ status: 409, json: async () => ({ state: "disk_away", disk: "Tiny Drive" }) }));
    expect(await whyNot("ctlocal://media/L2E")).toBe("Tiny Drive isn't connected");
    expect(await whyNot("/api/library/media/v1/play")).toBeUndefined();
  });
});

describe("a picture not ready yet", () => {
  it("keeps the frame drawn last on screen, never paints black over it while the file opens", async () => {
    let fills = 0;
    const ctx = new Proxy({} as Record<string | symbol, unknown>, {
      get: (t, k) => (k === "fillRect" ? () => void fills++ : k in t ? t[k] : () => {}),
      set: (t, k, v) => ((t[k] = v), true),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    // never loads here: the <video> stays without a frame
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(0);
    const urlOf = (): NleFile => ({ url: "/tiny/opening.mp4" });
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(<NlePlayer tl={tl} time={0} playing={false} rate={1} urlOf={urlOf} nameOf={() => "opening.mp4"} />));
    await act(() => new Promise((done) => setTimeout(done, 150)));
    expect(fills).toBe(1); // the first frame only (nothing to keep yet)
    act(() => root.unmount());
  });
});
