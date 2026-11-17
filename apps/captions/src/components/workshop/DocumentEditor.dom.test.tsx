// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TextArea } from "./DocumentEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("a drag-select that ends outside the field still gets the Cite pill; a triple-click doesn't", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const picked = vi.fn();
  await act(async () => root.render(<TextArea value="like a supported plank" disabled={false} onChange={() => {}} onSelectRange={picked} />));
  const el = host.querySelector("textarea")!;
  el.focus();
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.setSelectionRange(7, 22);
  document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 100, clientY: 200, detail: 1 }));
  expect(picked).toHaveBeenLastCalledWith(7, 22, { x: 106, y: 210 });

  picked.mockClear();
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 100, clientY: 200, detail: 3 }));
  expect(picked).toHaveBeenLastCalledWith(7, 22, undefined);
  act(() => root.unmount());
});
