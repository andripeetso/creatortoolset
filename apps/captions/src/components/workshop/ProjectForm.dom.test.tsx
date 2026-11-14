// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ProjectForm } from "./ProjectForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const drop = (el: Element, files: File[]) => {
  const e = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], files } });
  act(() => void el.dispatchEvent(e));
  return e;
};

it("a file dropped on the instructions opens the box that writes them, with the file in it; a file it can't read is named", () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(<ProjectForm busy={false} onSave={() => {}} />));
  const notes = host.querySelector("#project-notes")!;
  expect(host.textContent).not.toContain("Write the instructions");

  const e = drop(notes, [new File(["We teach parents"], "about.md", { type: "text/markdown" })]);
  expect(e.defaultPrevented).toBe(true);
  expect(host.textContent).toContain("about.md");
  expect(host.textContent).toContain("Write the instructions");

  drop(notes, [new File(["x"], "clip.mov", { type: "video/quicktime" })]);
  expect(host.textContent).toContain("Can't read clip.mov");
  act(() => root.unmount());
  host.remove();
});
