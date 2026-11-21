// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { withKeys, type NleTimeline } from "@/lib/nle/model";
import { NleClock, nleAudio } from "@/lib/nle/audio";
import { NlePlayer, playedPieces, whyNot, type NleFile } from "./NlePlayer";

afterEach(() => vi.unstubAllGlobals());

// a stand-in for the graphics stage (no WebGL in this test page): it keeps a texture for each picture drawn until the
// player lets it go; off, the player draws the 2D way as before
const fake = vi.hoisted(() => {
  const st = { on: false, live: new Set<unknown>(), drawn: [] as unknown[] };
  const painter = () =>
    new Proxy({} as Record<string | symbol, unknown>, {
      get: (t, k) => (k === "drawImage" || k === "blurFill" ? (src: unknown) => void (st.drawn.push(src), st.live.add(src)) : k in t ? t[k] : () => {}),
      set: (t, k, v) => ((t[k] = v), true),
    });
  const stage = () => ({
    canvas: document.createElement("canvas"),
    screen: painter(),
    layer: Object.assign(painter(), { token: document.createElement("canvas") }),
    lost: false,
    tainted: false,
    begin: () => {},
    present: () => {},
    scopes: () => null,
    forget: (src: unknown) => void st.live.delete(src),
    dispose: () => {},
  });
  return Object.assign(st, { stage });
});
vi.mock("@/lib/nle/gl-stage", async (real) => ({ ...(await real<object>()), glStage: () => (fake.on ? fake.stage() : null) }));

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
  it("a blend of two files of one recording plays both, each at its share of the clip's gain", () => {
    const voice = withKeys({
      timeline: { fps: 25, width: 1080, height: 1920 },
      sources: { vo: { fps: 25 } },
      tracks: { A1: { items: [{ src: "vo", rec: 0, len: 50, in: 0, gain_db: 6 }] } },
    } as unknown as NleTimeline);
    const g = 10 ** (6 / 20);
    const [a, b, ...rest] = playedPieces(voice, () => ({ url: "/tiny/VO.original.flac", mix: { url: "/tiny/VO.clean.flac", share: 0.25 } }));
    expect(rest).toEqual([]);
    expect([a.url, b.url]).toEqual(["/tiny/VO.original.flac", "/tiny/VO.clean.flac"]);
    expect([a.gain, b.gain].map((x) => Math.round(x * 1000))).toEqual([g * 0.75, g * 0.25].map((x) => Math.round(x * 1000)));
    expect([a.at, a.offset, a.dur]).toEqual([b.at, b.offset, b.dur]);   // laid together, sample for sample
    expect(a.key).not.toBe(b.key);
    expect(playedPieces(voice, () => ({ url: "/tiny/VO.original.flac" })).map((p) => p.gain)).toEqual([g]);
  });
});

describe("on the graphics stage", () => {
  afterEach(() => {
    fake.on = false;
    fake.live.clear();
    fake.drawn.length = 0;
    vi.restoreAllMocks();
  });
  const byHand = () => {
    let next = null as FrameRequestCallback | null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => ((next = cb), 1));
    vi.stubGlobal("cancelAnimationFrame", () => void (next = null));
    return (n: number) => {
      for (let i = 0; i < n; i++) next?.(i * 16);
    };
  };

  it("a numbered picture sequence keeps a texture only for the pictures it still holds, however long it plays", async () => {
    fake.on = true;
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(1080);
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(1920);
    const run = byHand();
    const card = withKeys({ timeline: { fps: 25, width: 1080, height: 1920 }, sources: { c: { fps: 25 } }, tracks: { V1: { items: [{ src: "c", rec: 0, len: 400, in: 0 }] } } } as unknown as NleTimeline);
    const urlOf = (): NleFile => ({ url: "/tiny/card/0.png", frame: (n) => `/tiny/card/${n}.png` });
    const clock = new NleClock();
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(<NlePlayer tl={card} clock={clock} rate={1} urlOf={urlOf} nameOf={() => "card"} />));
    let most = 0;
    for (let f = 0; f < 300; f++) {
      clock.seek(f / 25);
      run(1);
      most = Math.max(most, [...fake.live].filter((x) => x instanceof HTMLImageElement).length);
    }
    expect(fake.drawn.filter((x) => x instanceof HTMLImageElement).length).toBeGreaterThan(250);
    expect(most).toBeLessThanOrEqual(4);
    act(() => root.unmount());
  });

  it("a clip with a grade or a camera conversion is never shown as its plain <video>; a plain one is", async () => {
    fake.on = true;
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
    vi.spyOn(HTMLMediaElement.prototype, "seeking", "get").mockReturnValue(false);
    // this test page's <video> has no size of its own
    for (const [k, v] of [["videoWidth", 1080], ["videoHeight", 1920]] as const) Object.defineProperty(HTMLVideoElement.prototype, k, { get: () => v, configurable: true });
    onTestFinished(() => {
      for (const k of ["videoWidth", "videoHeight"]) Reflect.deleteProperty(HTMLVideoElement.prototype, k);
    });
    vi.spyOn(HTMLMediaElement.prototype, "src", "set").mockImplementation(() => {});
    const shown = async (item: object, camera?: object, log?: boolean) => {
      const run = byHand();
      const one = withKeys({ timeline: { fps: 25, width: 1080, height: 1920 }, sources: { a: { fps: 25, ...(camera ? { camera } : {}) } }, tracks: { V1: { items: [{ src: "a", rec: 0, len: 50, in: 0, ...item }] } } } as unknown as NleTimeline);
      const box = document.body.appendChild(document.createElement("div"));
      const root = createRoot(box);
      await act(async () => root.render(<NlePlayer tl={one} clock={new NleClock()} rate={1} urlOf={() => ({ url: "/tiny/talk.mp4", log })} nameOf={() => "talk"} />));
      fake.drawn.length = 0;
      run(10);
      const out = { video: [...box.querySelectorAll("video")].some((v) => v.style.visibility === "visible"), drawn: fake.drawn.some((x) => x instanceof HTMLVideoElement) };
      act(() => root.unmount());
      return out;
    };
    expect(await shown({})).toEqual({ video: true, drawn: false });
    expect(await shown({ grade: { sat: 1.3 } })).toEqual({ video: false, drawn: true });
    expect(await shown({}, { curve: "slog3", on: true })).toEqual({ video: false, drawn: true });
    // a file already converted (log: false) is never converted again: with no grade it plays as it is
    expect(await shown({}, { curve: "slog3", on: true }, false)).toEqual({ video: true, drawn: false });
  });
});
