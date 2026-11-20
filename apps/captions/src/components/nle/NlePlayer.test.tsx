// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withKeys, type NleTimeline } from "@/lib/nle/model";
import { NleClock, nleAudio } from "@/lib/nle/audio";
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
    await act(async () => root.render(<NlePlayer tl={tl} clock={new NleClock()} rate={1} urlOf={urlOf} nameOf={() => "desktop.mp4"} />));
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
    vi.spyOn(HTMLMediaElement.prototype, "src", "set").mockImplementation(() => {});
    // the frames run by hand: 30 of them, half a second at 60 Hz
    let next = null as FrameRequestCallback | null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => ((next = cb), 1));
    vi.stubGlobal("cancelAnimationFrame", () => void (next = null));
    const urlOf = (): NleFile => ({ url: "/tiny/opening.mp4" });
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(<NlePlayer tl={tl} clock={new NleClock()} rate={1} urlOf={urlOf} nameOf={() => "opening.mp4"} />));
    for (let i = 0; i < 30; i++) next?.(i * 16);
    expect(fills).toBe(1); // the first frame only (nothing to keep yet)
    act(() => root.unmount());
  });
});

describe("the sound of a clip from a video file", () => {
  it("plays from the file's own element through the engine, never fetching the whole file; a sound file is still read", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      fetched.push(String(u));
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
    }));
    const node = () => ({ connect: (n: unknown) => n, disconnect: () => {}, gain: { cancelScheduledValues: () => {}, setValueAtTime: () => {}, linearRampToValueAtTime: () => {} } });
    const routed: unknown[] = [];
    vi.stubGlobal("AudioContext", class {
      state = "running";
      currentTime = 1;
      destination = {};
      resume = async () => {};
      createGain = node;
      createMediaElementSource = (el: unknown) => (routed.push(el), node());
      createBufferSource = () => ({ ...node(), start: () => {}, stop: () => {}, playbackRate: { value: 1 }, buffer: null });
      decodeAudioData = async () => ({ duration: 60 });
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const sources: [string, string][] = [];
    vi.spyOn(HTMLMediaElement.prototype, "src", "set").mockImplementation(function (this: HTMLMediaElement, v: string) {
      sources.push([this.tagName, v]);
    });
    const talk = withKeys({
      timeline: { fps: 25, width: 2160, height: 3840 },
      sources: { cam: { fps: 25 }, song: { fps: 25 } },
      tracks: {
        V1: { items: [{ src: "cam", rec: 0, len: 50, in: 0, link: 1 }] },
        A1: { items: [{ src: "cam", rec: 0, len: 50, in: 0, link: 1 }] },
        A2: { items: [{ src: "song", rec: 0, len: 50, in: 0 }] },
      },
    } as unknown as NleTimeline);
    const urls: Record<string, string> = { cam: "/tiny/IMG_0001.MOV", song: "/tiny/song.m4a" };
    const urlOf = (src: string): NleFile => ({ url: urls[src] });
    const clock = new NleClock();
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(<NlePlayer tl={talk} clock={clock} rate={1} urlOf={urlOf} nameOf={() => "IMG_0001"} />));
    expect(clock.sound).toBe(true);
    await act(async () => {
      nleAudio();
      clock.play(1);
      clock.ready();
      clock.tick();
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(fetched).not.toContain("/tiny/IMG_0001.MOV");
    expect(fetched).toContain("/tiny/song.m4a");
    expect(sources).toContainEqual(["AUDIO", "/tiny/IMG_0001.MOV"]);
    expect(routed).toHaveLength(1);
    act(() => root.unmount());
  });
});
