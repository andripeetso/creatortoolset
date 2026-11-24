// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportChoices, type ImportAsk } from "./ImportChoices";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  document.body.innerHTML = "";
  root = undefined;
});
const mount = (ask: ImportAsk) => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<ImportChoices ask={ask} />));
};
const box = (name: string) => [...document.querySelectorAll("label")].find((l) => l.textContent?.includes(name))?.querySelector<HTMLElement>("button");
const add = async () => {
  await act(async () => {
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Add")!.click();
  });
};

describe("the choices of one add", () => {
  it("starts from the library's settings and answers what was ticked", async () => {
    const done = vi.fn();
    mount({ count: 17, blur: false, proxies: true, libraryBlurs: false, done });
    expect(document.body.textContent).toContain("Add 17 files");
    act(() => box("Blur faces")!.click());
    // the blurred video is the proxy: no Proxies row while Blur faces is ticked
    expect(box("Proxies")).toBeUndefined();
    await add();
    expect(done).toHaveBeenCalledWith({ blur: true, proxies: true });
  });

  it("Proxies can be left off, and a row not asked for is not drawn", async () => {
    const done = vi.fn();
    mount({ count: 1, proxies: true, libraryBlurs: false, done });
    expect(box("Blur faces")).toBeUndefined();
    act(() => box("Proxies")!.click());
    await add();
    expect(done).toHaveBeenCalledWith({ blur: false, proxies: false });
  });
});
