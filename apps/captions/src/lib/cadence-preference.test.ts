import { afterEach, describe, expect, it, vi } from "vitest";
import { persistAutoCadence, storedAutoCadence } from "./cadence-preference";

afterEach(() => vi.unstubAllGlobals());

describe("automatic cadence preference", () => {
  it("is enabled for a first-time user", () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    expect(storedAutoCadence()).toBe(true);
  });

  it("remembers an opt-out", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    persistAutoCadence(false);
    expect(storedAutoCadence()).toBe(false);
    persistAutoCadence(true);
    expect(storedAutoCadence()).toBe(true);
  });

  it("falls back to enabled when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(storedAutoCadence()).toBe(true);
  });
});
