// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ListRow, Row } from "./kit-rows";

// The ⓘ after a label: a row with `tip` has the button, a row without one has none, and a tap opens the text.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, unmount: () => act(() => root.unmount()) };
}

it("a row with a tip has an ⓘ; a tap opens the tip text; a row without one has none", async () => {
  const withTip = render(<Row title="Proxy quality" tip="Higher quality looks sharper." />);
  const button = withTip.host.querySelector<HTMLButtonElement>('button[aria-label="About this"]');
  expect(button).not.toBeNull();
  expect(document.body.textContent).not.toContain("Higher quality looks sharper.");
  await act(async () => button!.click());
  expect(document.body.textContent).toContain("Higher quality looks sharper.");
  withTip.unmount();

  const without = render(<Row title="Upload to server" />);
  expect(without.host.querySelector('button[aria-label="About this"]')).toBeNull();
  without.unmount();
});

it("a list row takes the same tip", () => {
  const list = render(<ListRow title="Final exports" tip="Where finished, clean exports are saved." />);
  expect(list.host.querySelector('button[aria-label="About this"]')).not.toBeNull();
  list.unmount();
});
