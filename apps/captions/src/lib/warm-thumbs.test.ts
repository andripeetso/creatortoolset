// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetCard, AssetPage } from "@contracts/library";
import { warmThumbs } from "./warm-thumbs";

const card = (id: string, thumb = true) => ({ id, versionId: `v${id}`, ...(thumb ? { thumbUrl: `/api/library/media/v${id}/thumb?v=1` } : {}) }) as AssetCard;
const pages: Record<string, AssetPage> = {
  "": { items: [card("1"), card("2", false)], next: "c2" },
  c2: { items: [card("3")] },
};

afterEach(() => {
  delete document.documentElement.dataset.macLocalThumbs;
});

describe("warmThumbs", () => {
  it("in the Mac app, loads every page's thumbnails through this Mac's copy, once per library", async () => {
    document.documentElement.dataset.macLocalThumbs = "1";
    const load = vi.fn(async () => {});
    const list = async (cursor?: string) => pages[cursor ?? ""]!;
    expect(await warmThumbs("lib_a", { list, load })).toBe(2);
    expect(load.mock.calls.map((c) => (c as unknown as [string])[0]).every((s) => s.startsWith("ctlocal://thumb/"))).toBe(true);
    expect(await warmThumbs("lib_a", { list, load })).toBe(0);
  });

  it("outside the Mac app asks for nothing", async () => {
    const load = vi.fn(async () => {});
    expect(await warmThumbs("lib_b", { list: async () => pages[""]!, load })).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });

  it("a failed list lets the next call try again", async () => {
    document.documentElement.dataset.macLocalThumbs = "1";
    const load = vi.fn(async () => {});
    expect(await warmThumbs("lib_c", { list: async () => Promise.reject(new Error("offline")), load })).toBe(0);
    expect(await warmThumbs("lib_c", { list: async () => pages.c2!, load })).toBe(1);
  });
});
