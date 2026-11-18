// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ListRow, Row } from "./kit-rows";

// The ⓘ after a label: a row with `tip` has the button, a row without one has none; hover (after 350 ms), Tab focus
// and tap each open the text, and a tap shows it once (the popover), not also in the tooltip.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((u) => u());
  vi.useRealTimers();
});

function render(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  mounted.push(unmount);
  return { host, unmount };
}

const infoButton = (host: HTMLElement, title: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="About ${title}"]`);

it("a row with a tip has an ⓘ named for its row; a row without one has none", () => {
  const withTip = render(<Row title="Proxy quality" tip="Higher quality looks sharper." />);
  expect(infoButton(withTip.host, "Proxy quality")).not.toBeNull();
  const without = render(<Row title="Upload to server" />);
  expect(without.host.querySelector("button[aria-label^='About']")).toBeNull();
});

it("a list row takes the same tip", () => {
  const list = render(<ListRow title="Final exports" tip="Where finished, clean exports are saved." />);
  expect(infoButton(list.host, "Final exports")).not.toBeNull();
});

it("Tab focus opens the tip text", () => {
  const row = render(<Row title="Proxy quality" tip="Higher quality looks sharper." />);
  act(() => infoButton(row.host, "Proxy quality")!.focus());
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Higher quality looks sharper.");
});

it("hover opens the tip after 350 ms, not before", () => {
  vi.useFakeTimers();
  const row = render(<Row title="Proxy quality" tip="Higher quality looks sharper." />);
  const button = infoButton(row.host, "Proxy quality")!;
  act(() => {
    button.dispatchEvent(new Event("pointermove", { bubbles: true }));
  });
  act(() => vi.advanceTimersByTime(300));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  act(() => vi.advanceTimersByTime(100));
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Higher quality looks sharper.");
});

it("a tap opens the text once, in the popover, and no tooltip", () => {
  const row = render(<Row title="Proxy quality" tip="Higher quality looks sharper." />);
  const button = infoButton(row.host, "Proxy quality")!;
  act(() => {
    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    button.focus();
    button.click();
  });
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Higher quality looks sharper.");
});
