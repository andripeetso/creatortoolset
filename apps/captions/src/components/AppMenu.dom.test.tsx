// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppMenu } from "./AppMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const rightClick = (el: Element) => {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  act(() => void el.dispatchEvent(e));
  return e.defaultPrevented;
};
const mount = () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<AppMenu />));
};
beforeEach(() => {
  document.documentElement.dataset.macThisMac = "1";
  document.documentElement.dataset.macEdit = "1";
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  delete document.documentElement.dataset.macThisMac;
  delete document.documentElement.dataset.macEdit;
});

describe("AppMenu", () => {
  it("shows no system menu on a spot with no menu of its own", () => {
    mount();
    const spot = document.body.appendChild(document.createElement("div"));
    expect(rightClick(spot)).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("shows its own Cut, Copy, Paste in a text field", () => {
    mount();
    const input = document.body.appendChild(document.createElement("input"));
    expect(rightClick(input)).toBe(true);
    expect(document.querySelector('[role="menu"]')?.textContent).toBe("CutCopyPasteSelect all");
  });

  it("leaves a field the system's menu on an older Mac app, and everything on a plain browser", () => {
    delete document.documentElement.dataset.macEdit;
    mount();
    expect(rightClick(document.body.appendChild(document.createElement("textarea")))).toBe(false);
    act(() => root.unmount());
    delete document.documentElement.dataset.macThisMac;
    mount();
    expect(rightClick(document.body.appendChild(document.createElement("div")))).toBe(false);
  });

  it("gives a checkbox no text menu", () => {
    mount();
    const box = document.body.appendChild(document.createElement("input"));
    box.type = "checkbox";
    expect(rightClick(box)).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
