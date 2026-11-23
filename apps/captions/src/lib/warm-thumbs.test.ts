// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetCard, AssetPage } from "@contracts/library";
import { warmThumbs } from "./warm-thumbs";

const card = (id: string, thumb = true) => ({ id, versionId: `v${id}`, ...(thumb ? { thumbUrl: `/api/library/media/v${id}/thumb?v=1` } : {}) }) as AssetCard;
const pages: Record<string, AssetPage> = {
  "": { items: [card("1"), card("2", false)], next: "c2" },
  c2: { items: [card("3")] },
};
const list = async (cursor?: string) => pages[cursor ?? ""]!;

beforeEach(() => {
  vi.stubGlobal("requestIdleCallback", (f: () => void) => setTimeout(f, 0));
  document.documentElement.dataset.macLocalThumbs = "1";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.macLocalThumbs;
  localStorage.clear();
});

describe("warmThumbs", () => {
  it("in the Mac app, loads every page's thumbnails through this Mac's copy, once per library", async () => {
    const load = vi.fn(async () => {});
    expect(await warmThumbs("lib_a", { list, load })).toBe(2);
    expect(load.mock.calls.map((c) => (c as unknown as [string])[0]).every((s) => s.startsWith("ctlocal://thumb/"))).toBe(true);
    expect(await warmThumbs("lib_a", { list, load })).toBe(0);
  });

  it("outside the Mac app asks for nothing", async () => {
    delete document.documentElement.dataset.macLocalThumbs;
    const load = vi.fn(async () => {});
    expect(await warmThumbs("lib_b", { list, load })).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });

  it("a failed list lets the next call try again", async () => {
    const load = vi.fn(async () => {});
    expect(await warmThumbs("lib_c", { list: async () => Promise.reject(new Error("offline")), load })).toBe(0);
    expect(await warmThumbs("lib_c", { list: async () => pages.c2!, load })).toBe(1);
  });

  it("stops at 5,000 pictures, so the newest clips' pictures are never pushed out of this Mac's copy", async () => {
    let n = 0;
    const endless = async () => ({ items: Array.from({ length: 200 }, () => card(String(n++))), next: "more" });
    expect(await warmThumbs("lib_d", { list: endless, load: async () => {} })).toBe(5000);
  });

  it("within a day of a whole pass, warms only the newest page", async () => {
    localStorage.setItem("ct-warm-thumbs:lib_e", String(1_000_000));
    const seen: (string | undefined)[] = [];
    await warmThumbs("lib_e", { list: async (c) => (seen.push(c), list(c)), load: async () => {}, now: 1_000_000 + 3600_000 });
    expect(seen).toEqual([undefined]);
  });
});
