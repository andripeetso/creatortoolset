// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ProjectForm } from "./ProjectForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const drop = (el: Element, files: File[]) => {
  const e = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], files } });
  act(() => void el.dispatchEvent(e));
  return e;
};

vi.stubGlobal("fetch", () => new Promise(() => {}));

it("a file dropped on the instructions shows at the top of the box; saving with it unused says so; a file it can't read is named", () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const saved: unknown[] = [];
  act(() => root.render(<ProjectForm busy={false} onSave={(f) => void saved.push(f)} />));
  const notes = host.querySelector("#project-notes")!;
  expect(host.textContent).not.toContain("about.md");

  const e = drop(notes, [new File(["We teach parents"], "about.md", { type: "text/markdown" })]);
  expect(e.defaultPrevented).toBe(true);
  expect(host.querySelector('[aria-label="Remove about.md"]')).toBeTruthy();

  const name = host.querySelector<HTMLInputElement>('input[required]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Tiny");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => void host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(saved).toEqual([]);
  expect(host.textContent).toContain("Write the instructions from the files first");

  drop(notes, [new File(["x"], "clip.mov", { type: "video/quicktime" })]);
  expect(host.textContent).toContain("Can't read clip.mov");
  act(() => root.unmount());
  host.remove();
});
