// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaceholderTile, commonAspect, placeholderShown, placeholderWide, summaryLine } from "./Placeholders";
import type { Upload } from "./Uploads";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file = (name: string) => new File(["x".repeat(10)], name, { type: "video/mp4" });
const up = (key: number, status: Upload["status"], extra: Partial<Upload> = {}): Upload => ({ key, file: file(`Tiny ${key}.mp4`), sent: 0, status, ...extra });

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
});
const mount = (node: React.ReactNode) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
};

describe("the summary line", () => {
  it("counts the drop, what is done, the time left at the pace so far, and the cost total", () => {
    const batch = [up(1, "added"), up(2, "duplicate"), up(3, "uploading"), up(4, "waiting"), up(5, "cancelled")];
    // 2 done in 60 s, 2 left: about 1 min left
    expect(summaryLine(batch, 0, 60_000, 11.4)).toBe("Adding 4 clips · 2 done · about 1 min left · about $11");
  });
  it("no cost when none is given (Effort Off), no time before the first is done, and the failed ones counted", () => {
    expect(summaryLine([up(1, "waiting"), up(2, "failed")], 0, 5_000, null)).toBe("Adding 2 clips · 0 done · 1 not added");
  });
  it("is gone once nothing is going in", () => {
    expect(summaryLine([up(1, "added"), up(2, "failed")], 0, 5_000, 3)).toBeNull();
  });
});

describe("the cards of a drop", () => {
  it("shows a card while going or failed, and an added one only until its clip's own card is on the page", () => {
    const onPage = (id: string) => id === "a_on";
    expect(placeholderShown(up(1, "waiting"), onPage)).toBe(true);
    expect(placeholderShown(up(1, "failed"), onPage)).toBe(true);
    expect(placeholderShown(up(1, "added", { assetId: "a_off" }), onPage)).toBe(true);
    expect(placeholderShown(up(1, "added", { assetId: "a_on" }), onPage)).toBe(false);
    expect(placeholderShown(up(1, "duplicate"), onPage)).toBe(false);
    expect(placeholderShown(up(1, "cancelled"), onPage)).toBe(false);
  });

  it("a waiting card is grey with no bar; a working one runs its bar; a copy shows how far it is", () => {
    expect(mount(<PlaceholderTile upload={up(1, "waiting")} onRetry={() => {}} onCancel={() => {}} />).querySelector('[aria-label="Adding"]')).toBeNull();
    act(() => root!.render(<PlaceholderTile upload={up(1, "copying", { sent: 5 })} onRetry={() => {}} onCancel={() => {}} />));
    expect(host!.querySelector<HTMLElement>('[aria-label="Adding"] div')?.style.width).toBe("50%");
    expect(host!.textContent).toContain("Tiny 1.mp4");
    act(() => root!.render(<PlaceholderTile upload={up(1, "waiting")} onRetry={() => {}} onCancel={() => {}} />));
    expect(host!.textContent).toContain("Queued");
    act(() => root!.render(<PlaceholderTile upload={up(1, "added", { assetId: "a_off" })} onRetry={() => {}} onCancel={() => {}} />));
    expect(host!.textContent).not.toContain("Queued");
    expect(host!.querySelector('[aria-label="Added"]')).not.toBeNull();
  });

  it("a failed card has its red mark and Retry", () => {
    const retry = vi.fn();
    const el = mount(<PlaceholderTile upload={up(1, "failed", { error: "The share went away" })} onRetry={retry} onCancel={() => {}} />);
    expect(el.querySelector('[aria-label="Not added"]')).not.toBeNull();
    act(() => [...el.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

// 11-19 (CEO, Andri: "fill the row height"): a card is its clip's card's size, so a mixed row lines up and nothing moves
describe("a drop's card in a row of clips", () => {
  const portrait = { kind: "video" as const, width: 1080, height: 1920 };
  const asset = (id: string, w: number, h: number) => ({ id, kind: "video", title: id, tags: [], state: "ready", width: w, height: h }) as never;

  it("in the Gallery, among tall clips, it is a tall cell filling the row's height, in every state", async () => {
    const { GalleryGrid } = await import("./Gallery");
    const usual = commonAspect([portrait, portrait, { width: 1920, height: 1080 }]);
    expect(usual).toBeCloseTo(9 / 16);
    const lead = (["waiting", "uploading", "failed"] as const).map((s, i) => {
      const u = up(i + 1, s);
      const wide = placeholderWide(u, usual);
      return { key: `up-${i}`, wide, node: <PlaceholderTile gallery wide={wide} upload={u} onRetry={() => {}} onCancel={() => {}} /> };
    });
    const el = mount(<GalleryGrid assets={[asset("a", 1080, 1920), asset("b", 1080, 1920)]} lead={lead} tile={(a) => <div data-card={a.id} className="aspect-[3/4]" />} />);
    const cards = [...el.querySelectorAll("[data-placeholder]")];
    expect(cards).toHaveLength(3);
    for (const c of cards) {
      expect(c.parentElement!.className).not.toContain("col-span-2"); // one cell, like a tall clip's
      expect(c.className).toContain("h-full"); // the row's height (a grid cell stretches to it)
      const frame = c.querySelector("[data-frame]")!;
      expect(frame.className).toContain("flex-1");
      expect(frame.className).toContain("aspect-[3/4]"); // the tall clip card's own shape (Gallery.tsx)
      expect(c.querySelector("p")).toBeNull(); // the name is on the picture, as the Gallery's cards have nothing under them
    }
  });

  it("takes the file's own shape once read: wide is two cells at the same height, like a wide clip's card", () => {
    expect(placeholderWide(up(1, "waiting"), 9 / 16)).toBe(false);
    expect(placeholderWide(up(1, "waiting", { aspect: 16 / 9 }), 9 / 16)).toBe(true);
    expect(placeholderWide(up(1, "waiting", { aspect: 9 / 16 }), 16 / 9)).toBe(false);
    // before it is read: the library's usual shape (a landscape library, landscape cards); none on the page, a phone's
    expect(placeholderWide(up(1, "waiting"), commonAspect([{ width: 1920, height: 1080 }]))).toBe(true);
    expect(commonAspect([])).toBeCloseTo(9 / 16);
    const el = mount(<PlaceholderTile gallery wide upload={up(1, "copying", { aspect: 16 / 9 })} onRetry={() => {}} onCancel={() => {}} />);
    expect(el.querySelector("[data-frame]")!.className).toContain("aspect-[3/2]");
  });

  it("in the folders view it is the clip card's frame with the name under it", () => {
    const el = mount(<PlaceholderTile upload={up(1, "waiting")} onRetry={() => {}} onCancel={() => {}} />);
    expect(el.querySelector("[data-frame]")!.className).toContain("aspect-video");
    expect(el.querySelector("p")?.textContent).toBe("Tiny 1.mp4");
  });
});
