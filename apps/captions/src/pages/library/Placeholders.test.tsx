// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaceholderTile, placeholderShown, summaryLine } from "./Placeholders";
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
  });

  it("a failed card has its red mark and Try again", () => {
    const retry = vi.fn();
    const el = mount(<PlaceholderTile upload={up(1, "failed", { error: "The share went away" })} onRetry={retry} onCancel={() => {}} />);
    expect(el.querySelector('[aria-label="Not added"]')).not.toBeNull();
    act(() => [...el.querySelectorAll("button")].find((b) => b.textContent === "Try again")!.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
