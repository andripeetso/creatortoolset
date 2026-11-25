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

const ticked = (name: string) => option(name)?.getAttribute("aria-checked");

describe("the sheet of one add", () => {
  it("processing is two ticks, each from the library's setting: a file can get both", async () => {
    const done = vi.fn();
    mount({ id: 1, count: 17, start: { blur: false, proxy: true }, blurOffered: true, outside: 0, done });
    expect(document.body.textContent).toContain("Add 17 files");
    expect(option("Upload to server")).toBeUndefined(); // what is uploaded is never asked here
    expect([ticked("Blur faces"), ticked("Generate proxies")]).toEqual(["false", "true"]);
    act(() => option("Blur faces")!.click());
    expect([ticked("Blur faces"), ticked("Generate proxies")]).toEqual(["true", "true"]);
    expect(document.querySelector('a[href="/settings/blur-faces"]')).not.toBeNull();
    expect(option("Copy to Media Library")).toBeUndefined();
    await add();
    expect(done).toHaveBeenCalledWith({ blur: true, proxy: true, copy: true });
  });

  it("neither ticked is no processing; files from outside get Location in the same sheet", async () => {
    const done = vi.fn();
    mount({ id: 2, count: 24, start: { blur: false, proxy: true }, blurOffered: false, outside: 3, done });
    expect(option("Blur faces")).toBeUndefined();
    expect(document.body.textContent).toContain("3 of 24 files are outside Folder access.");
    expect(option("Copy to Media Library")!.getAttribute("aria-checked")).toBe("true");
    act(() => option("Generate proxies")!.click());
    act(() => option("Use where they are")!.click());
    await add();
    expect(done).toHaveBeenCalledWith({ blur: false, proxy: false, copy: false });
  });

  it("where Blur faces is no choice (a member's file in a library that blurs), the files stay blurred and proxies are still asked", async () => {
    const done = vi.fn();
    mount({ id: 3, count: 2, start: { blur: true, proxy: false }, blurOffered: false, outside: 0, done });
    expect(option("Blur faces")).toBeUndefined();
    expect(ticked("Generate proxies")).toBe("false");
    await add();
    expect(done).toHaveBeenCalledWith({ blur: true, proxy: false, copy: true });
  });

  it("unticking Blur faces where the library blurs asks first, and Cancel adds nothing", async () => {
    const done = vi.fn();
    vi.stubGlobal("confirm", () => false);
    mount({ id: 4, count: 1, start: { blur: true, proxy: true }, blurOffered: true, outside: 0, done });
    act(() => option("Blur faces")!.click());
    await add();
    expect(done).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("the answer as an add's options", () => {
  const remote = { start: { blur: false, proxy: false }, libraryBlurs: false, macRemote: true, onMac: false, hostsOriginals: false };
  const fromProxies = { ...remote, start: { blur: false, proxy: true } };
  it("Generate proxies ticked asks for one; what is sent is the library's Upload", () => {
    expect(importOptions({ blur: false, proxy: true }, remote)).toEqual({ mac: false, blur: false, asFilmed: false, askBlur: false, proxy: "yes" });
  });
  it("Generate proxies unticked: no proxy, and nothing sent where the library keeps only proxies", () => {
    expect(importOptions({ blur: false, proxy: false }, fromProxies)).toMatchObject({ mac: true, proxy: "no" });
    // a library that keeps originals still gets the original
    expect(importOptions({ blur: false, proxy: false }, { ...fromProxies, hostsOriginals: true })).toMatchObject({ mac: false, proxy: "no" });
  });
  it("Add as the sheet opened keeps no proxy answer: the file follows the library, so proxies turned on later cover it", () => {
    expect(importOptions({ blur: false, proxy: false }, remote)).not.toHaveProperty("proxy");
    expect(importOptions({ blur: false, proxy: true }, fromProxies)).not.toHaveProperty("proxy");
    // Blur faces ticked changes nothing about the proxy answer
    expect(importOptions({ blur: true, proxy: true }, fromProxies)).not.toHaveProperty("proxy");
  });
  it("both ticked where the library does neither: indexed here, blur asked for and a proxy too", () => {
    expect(importOptions({ blur: true, proxy: true }, remote)).toEqual({ mac: true, blur: true, asFilmed: false, askBlur: true, proxy: "yes" });
  });
  it("Blur faces unticked where the library blurs: kept as filmed", () => {
    expect(importOptions({ blur: false, proxy: true }, { ...fromProxies, libraryBlurs: true, onMac: true })).toMatchObject({ mac: true, asFilmed: true });
  });
});
