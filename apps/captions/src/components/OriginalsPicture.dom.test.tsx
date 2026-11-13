// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewPlayPlan } from "@/lib/plugin";
import { useEditSound } from "@/lib/synced-sound";
import { OriginalsPicture } from "./OriginalsPicture";

// When an original can't be played (not found, not allowed, a decode error, a stall), Review plays the finished video as
// before: the original picture layer hides and lets the render show, the original sound hands back to the video's own.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

const plan: ReviewPlayPlan = {
  fps: 25, skips: [], mutes: [], holds: [], cards: [], frames: [],
  picture: [{ src: "ctlocal://media/a", at: 0, frames: 250, offset: 2, x: 0, y: 0, s: 1 }],
  sound: [{ src: "ctlocal://media/vo", at: 0, frames: 250, offset: 0 }],
};

/** A media element that is playing, ready, and whose time runs on by itself (`stuck` = setting its time does nothing). */
function live(el: HTMLMediaElement, opts: { ready?: boolean; stuck?: boolean } = {}) {
  let t = 0;
  Object.defineProperties(el, {
    paused: { get: () => false, configurable: true },
    ended: { get: () => false, configurable: true },
    readyState: { get: () => (opts.ready === false ? 0 : 4), configurable: true },
    playbackRate: { get: () => 1, set: () => {}, configurable: true },
    currentTime: { get: () => t, set: (v: number) => { if (!opts.stuck) t = v; }, configurable: true },
  });
  el.play = () => Promise.resolve();
  el.pause = () => {};
  el.load = () => {};
  return { tick: (d: number) => (t += d) };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("the original picture falls back to the render", () => {
  async function mount(players: { ready?: boolean; stuck?: boolean }) {
    const render = document.createElement("video");
    const clock = live(render);
    const ref = createRef<HTMLVideoElement>() as { current: HTMLVideoElement | null };
    ref.current = render;
    await act(async () => root.render(<OriginalsPicture video={ref} plan={plan} holding={0} />));
    const [a, b] = [...host.querySelectorAll("video")];
    const runs = [live(a, players), live(b, players)];
    const timer = setInterval(() => {
      clock.tick(0.04);
      runs.forEach((r) => !players.stuck && r.tick(0.04));
    }, 40);
    return { a, b, layer: host.firstElementChild as HTMLDivElement, stop: () => clearInterval(timer) };
  }
  const visible = (v: HTMLVideoElement) => v.style.visibility === "visible";

  it("shows the take while its file plays", async () => {
    const { a, b, layer, stop } = await mount({});
    await wait(200);
    expect(visible(a) || visible(b)).toBe(true);
    expect(layer.style.background).toBe("black");
    stop();
  });

  it("a file that errors hands back to the render for good", async () => {
    const { a, b, layer, stop } = await mount({});
    await wait(200);
    const on = visible(a) ? a : b;
    await act(async () => on.dispatchEvent(new Event("error")));
    await wait(200);
    expect(visible(a) || visible(b)).toBe(false);
    expect(layer.style.background).toBe("transparent");
    stop();
  });

  it("a file that never loads never covers the render", async () => {
    const { a, b, stop } = await mount({ ready: false });
    await wait(200);
    expect(visible(a) || visible(b)).toBe(false);
    stop();
  });

  it("a stall (its picture stops while the clock runs) shows the render until it moves", async () => {
    const { a, b, stop } = await mount({ stuck: true });
    await wait(900);
    expect(visible(a) || visible(b)).toBe(false);
    stop();
  });
});

describe("the original sound falls back to the video's own", () => {
  function Probe({ video, onState }: { video: { current: HTMLVideoElement | null }; onState: (s: { live: boolean; error: string }) => void }) {
    onState(useEditSound(video, plan, 0));
    return null;
  }
  const run = async () => {
    const el = document.createElement("video");
    live(el);
    let state = { live: true, error: "" };
    await act(async () => root.render(<Probe video={{ current: el }} onState={(s) => (state = s)} />));
    await wait(50);
    return state;
  };

  it("no sound engine in this browser: the video keeps its sound", async () => {
    const had = (globalThis as { AudioContext?: unknown }).AudioContext;
    (globalThis as { AudioContext?: unknown }).AudioContext = class { constructor() { throw new Error("blocked"); } };
    try {
      expect(await run()).toEqual({ live: false, error: "blocked" });
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = had;
    }
  });

  it("a recording that won't load: the video keeps its sound", async () => {
    const had = (globalThis as { AudioContext?: unknown }).AudioContext;
    const gain = () => ({ connect: () => {}, gain: { setTargetAtTime: () => {} } });
    (globalThis as { AudioContext?: unknown }).AudioContext = class {
      destination = {};
      currentTime = 0;
      createGain = gain;
      resume = () => Promise.resolve();
      close = () => Promise.resolve();
    };
    const fetched = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 403 })) as typeof fetch;
    try {
      const s = await run();
      expect(s.live).toBe(false);
      expect(s.error).toContain("403");
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = had;
      globalThis.fetch = fetched;
    }
  });
});
