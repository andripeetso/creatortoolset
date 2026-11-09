import { describe, expect, it, vi } from "vitest";
import { publicGridReader, registerPublicGridReader } from "./provider";
import { fetchPublicGridKeys } from "../instagram/graph";

// Runs with no plug-in loaded: the public build has no public-grid read, so the call answers empty and never fetches.
describe("public-grid read through the connector registry", () => {
  it("answers empty with no request when no plug-in registered a reader", async () => {
    const fetchImpl = vi.fn();
    const r = await fetchPublicGridKeys("tinyacrobatics", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(publicGridReader()).toBeNull();
    expect(r.ok).toBe(false);
    expect(r.shortcodes.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("hands the call to the registered reader with its options", async () => {
    const read = vi.fn(async () => ({ ok: true, complete: true, shortcodes: new Set(["ABC"]), ids: new Set<string>() }));
    registerPublicGridReader(read);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = await fetchPublicGridKeys("tinyacrobatics", { fetchImpl, maxPages: 2 });
    expect(read).toHaveBeenCalledWith("tinyacrobatics", { fetchImpl, maxPages: 2 });
    expect(r.ok).toBe(true);
    expect([...r.shortcodes]).toEqual(["ABC"]);
  });

  it("refuses a second, different reader", () => {
    expect(() => registerPublicGridReader(async () => ({ ok: false, complete: false, shortcodes: new Set(), ids: new Set() }))).toThrow(
      /already registered/,
    );
  });
});
