// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toggleChatMode, useChatMode } from "./chat-mode";

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

  it("switched again while the wave runs: the wave ends and the screen changes at once", async () => {
    let finish: (v: unknown) => void = () => {};
    const asked: unknown[] = [];
    const postMessage = vi.fn((m: unknown) => {
      asked.push(m);
      if (m === "drawn") return new Promise((r) => (finish = r));
      if (m === "stop") finish(true);
      return Promise.resolve(true);
    });
    (window as unknown as { webkit: object }).webkit = { messageHandlers: { chatWave: { postMessage } } };
    toggleChatMode();
    await settled();
    expect(useChatMode.getState().on).toBe(true);
    toggleChatMode();
    expect(useChatMode.getState().on).toBe(false);
    expect(asked).toContain("stop");
  });
});
