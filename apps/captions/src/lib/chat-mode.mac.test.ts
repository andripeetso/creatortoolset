// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clickChatMode, holdChatMode, toggleChatMode, useChatMode } from "./chat-mode";
import { persistChatWave } from "./settings";

/** The Mac app's side of the wave (ChatWave.swift), answering as told; what the page asked, and whether chat mode was
 *  on at the time. */
function macApp(start: unknown) {
  const asked: Array<{ m: unknown; on: boolean }> = [];
  const postMessage = vi.fn(async (m: unknown) => {
    asked.push({ m, on: useChatMode.getState().on });
    return typeof m === "object" ? start : true;
  });
  (window as unknown as { webkit: object }).webkit = { messageHandlers: { chatWave: { postMessage } } };
  return asked;
}
const settled = () => new Promise((r) => setTimeout(r, 30));

describe("chat mode switched in the Mac app", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0));
    useChatMode.setState({ on: false });
  });
  afterEach(() => {
    delete (window as { webkit?: unknown }).webkit;
    vi.unstubAllGlobals();
  });

  it("puts the picture up first, changes the screen under it, then lets the front go", async () => {
    const asked = macApp(true);
    toggleChatMode();
    await settled();
    expect(asked.map((a) => (typeof a.m === "object" ? "start" : a.m))).toEqual(["start", "drawn"]);
    // the picture of the screen as it was is taken before chat mode changes, the new one after
    expect(asked[0].on).toBe(false);
    expect(asked[1].on).toBe(true);
    expect((asked[0].m as { start: { x: number; y: number } }).start).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
  });

  it("still switches, with no wave, when the app has no picture to show", async () => {
    const asked = macApp(false);
    toggleChatMode();
    await settled();
    expect(useChatMode.getState().on).toBe(true);
    expect(asked.map((a) => (typeof a.m === "object" ? "start" : a.m))).toEqual(["start"]);
  });

  /** The Mac app, each wave held until `end()`: what the page asked, as "start", "drawn" or "stop". */
  function slowMacApp() {
    const asked: string[] = [];
    const waves: Array<(v: unknown) => void> = [];
    const postMessage = vi.fn((m: unknown) => {
      asked.push(typeof m === "object" ? "start" : String(m));
      if (m === "drawn") return new Promise((r) => waves.push(r));
      if (m === "stop") waves.forEach((r) => r(true));
      return Promise.resolve(true);
    });
    (window as unknown as { webkit: object }).webkit = { messageHandlers: { chatWave: { postMessage } } };
    return { asked, postMessage, end: () => waves.shift()?.(true) };
  }

  it("pressed again while the wave runs: the wave goes on to its end, then it switches back with a wave of its own", async () => {
    const mac = slowMacApp();
    toggleChatMode();
    await settled();
    toggleChatMode();
    await settled();
    expect(useChatMode.getState().on).toBe(true);
    expect(mac.asked).toEqual(["start", "drawn"]);
    mac.end();
    await settled();
    expect(useChatMode.getState().on).toBe(false);
    expect(mac.asked).toEqual(["start", "drawn", "start", "drawn"]);
    mac.end();
    await settled();
    expect(mac.asked).not.toContain("stop");
  });

  it("held while the wave runs: once it is over the switch back still says it is held (the app sees whether it still is)", async () => {
    const mac = slowMacApp();
    toggleChatMode();
    await settled();
    holdChatMode(null);
    clickChatMode(null, { detail: 1 });
    mac.end();
    await settled();
    expect(useChatMode.getState().on).toBe(false);
    expect(mac.asked).toEqual(["start", "drawn", "start", "drawn"]);
    expect((mac.postMessage.mock.calls[2][0] as { start: { hold: boolean } }).start.hold).toBe(true);
    mac.end();
    await settled();
  });

  it("pressed twice while the wave runs: it stays as that wave leaves it", async () => {
    const mac = slowMacApp();
    toggleChatMode();
    await settled();
    toggleChatMode();
    toggleChatMode();
    mac.end();
    await settled();
    expect(useChatMode.getState().on).toBe(true);
    expect(mac.asked).toEqual(["start", "drawn"]);
  });

  it("pressed with the mouse: switches as it goes down, the app is told it is held, and the click after it is the same press", async () => {
    const mac = slowMacApp();
    holdChatMode(null);
    await settled();
    expect(useChatMode.getState().on).toBe(true);
    expect(mac.asked).toEqual(["start", "drawn"]);
    expect((mac.postMessage.mock.calls[0][0] as { start: { hold: boolean } }).start.hold).toBe(true);
    clickChatMode(null, { detail: 1 });
    expect(mac.asked).toEqual(["start", "drawn"]);
    mac.end();
    await settled();
    expect(useChatMode.getState().on).toBe(true);
    // Enter or Space on the button (a click with no count) is a press of its own: a click, no hold
    clickChatMode(null, { detail: 0 });
    await settled();
    expect(useChatMode.getState().on).toBe(false);
    expect((mac.postMessage.mock.calls.at(-2)?.[0] as { start: { hold: boolean } }).start.hold).toBe(false);
    mac.end();
    await settled();
  });

  it("with the wave switched off in Settings → Appearance, it switches at once and asks the app for nothing", async () => {
    const asked = macApp(true);
    persistChatWave(false);
    try {
      toggleChatMode();
      expect(useChatMode.getState().on).toBe(true);
      await settled();
      expect(asked).toEqual([]);
    } finally {
      persistChatWave(true);
    }
  });
});
