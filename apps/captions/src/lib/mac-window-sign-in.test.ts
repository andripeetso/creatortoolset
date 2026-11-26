import { describe, expect, it } from "vitest";
import { macSignsWindowIn } from "./mac-window-sign-in";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const memory = () => {
  const kept = new Map<string, string>();
  return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
};

describe("macSignsWindowIn (a server's sign-in page asks the Mac app first)", () => {
  it("is true only when the app says it signed the window in", async () => {
    const asked: string[] = [];
    const app = (state: string) => ({ postMessage: async (m: string) => (asked.push(m), { state }) });
    expect(await macSignsWindowIn(NOW, app("signedIn"), memory())).toBe(true);
    expect(asked).toEqual(["window"]);
    // an older app, or a server the account never signed in to
    expect(await macSignsWindowIn(NOW, app("off"), memory())).toBe(false);
    expect(await macSignsWindowIn(NOW, { postMessage: async () => Promise.reject(new Error("gone")) }, memory())).toBe(false);
  });

  it("asks nothing outside the Mac app", async () => {
    expect(await macSignsWindowIn(NOW, undefined, memory())).toBe(false);
  });

  it("stops waiting on an app that does not answer in time, so the sign-in page shows", async () => {
    const never = { postMessage: () => new Promise<{ state?: string }>(() => {}) };
    expect(await macSignsWindowIn(NOW, never, memory(), 10)).toBe(false);
  });

  it("asks once a minute for a window: a sign-in that did not hold shows the sign-in page, never a loop", async () => {
    let asks = 0;
    const app = { postMessage: async () => (asks++, { state: "signedIn" }) };
    const store = memory();
    expect(await macSignsWindowIn(1_000_000, app, store)).toBe(true);
    expect(await macSignsWindowIn(1_030_000, app, store)).toBe(false);
    expect(asks).toBe(1);
    expect(await macSignsWindowIn(1_061_000, app, store)).toBe(true);
  });
});
