// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportChoices, importOptions, type ImportAsk } from "./ImportChoices";

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
  act(() =>
    root!.render(
      <MemoryRouter>
        <ImportChoices ask={ask} />
      </MemoryRouter>,
    ),
  );
};
const option = (name: string) => {
  const label = [...document.querySelectorAll("label")].find((l) => l.textContent === name);
  return label ? document.getElementById(label.htmlFor) ?? undefined : undefined;
};
const add = async () => {
  await act(async () => {
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Add")!.click();
  });
};

describe("the choice of one add", () => {
  it("Blur faces and Proxies are one choice: blurred, the blurred copy is the proxy", async () => {
    const done = vi.fn();
    mount({ id: 1, count: 17, blur: false, proxies: true, done });
    expect(document.body.textContent).toContain("Add 17 files");
    expect(option("Upload proxies")!.getAttribute("aria-checked")).toBe("true");
    act(() => option("Upload blurred proxies")!.click());
    expect(option("Upload proxies")!.getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector('a[href="/settings/blur-faces"]')).not.toBeNull();
    await add();
    expect(done).toHaveBeenCalledWith({ blur: true, proxies: true });
  });

  it("None sends nothing, and an option not asked for is not drawn", async () => {
    const done = vi.fn();
    mount({ id: 2, count: 1, proxies: true, done });
    expect(option("Upload blurred proxies")).toBeUndefined();
    act(() => option("Keep on this computer")!.click());
    await add();
    expect(done).toHaveBeenCalledWith({ blur: false, proxies: false });
  });

  it("no Proxies question: Blur faces or As filmed", () => {
    mount({ id: 3, count: 2, blur: true, done: vi.fn() });
    expect(option("Blur faces")!.getAttribute("aria-checked")).toBe("true");
    expect(option("Keep as filmed")).toBeDefined();
    expect(option("Keep on this computer")).toBeUndefined();
  });
});

describe("the answer as an add's options", () => {
  const remote = { libraryBlurs: false, macRemote: true, onMac: false };
  it("sends from this Mac only with Proxies ticked and Blur faces not", () => {
    expect(importOptions({ blur: false, proxies: true }, remote)).toEqual({ mac: false, blur: false, asFilmed: false, askBlur: false });
    expect(importOptions({ blur: false, proxies: false }, remote).mac).toBe(true);
  });
  it("Blur faces ticked where the library doesn't blur: indexed here and asked for", () => {
    expect(importOptions({ blur: true, proxies: true }, remote)).toEqual({ mac: true, blur: true, asFilmed: false, askBlur: true });
  });
  it("unticked where the library blurs: kept as filmed", () => {
    expect(importOptions({ blur: false, proxies: true }, { libraryBlurs: true, macRemote: true, onMac: true })).toEqual({ mac: true, blur: false, asFilmed: true, askBlur: false });
  });
  it("on the server's own computer nothing is indexed apart", () => {
    expect(importOptions({ blur: true, proxies: false }, { libraryBlurs: false, macRemote: false, onMac: false }).mac).toBe(false);
  });
});
