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

describe("the sheet of one add", () => {
  it("processing is one choice: a blurred version takes the proxy's place", async () => {
    const done = vi.fn();
    mount({ id: 1, count: 17, processes: ["proxies", "blur", "skip"], process: "proxies", outside: 0, done });
    expect(document.body.textContent).toContain("Add 17 files");
    expect(document.body.textContent).not.toContain("Upload");
    expect(option("Generate proxies")!.getAttribute("aria-checked")).toBe("true");
    act(() => option("Generate blurred versions")!.click());
    expect(option("Generate proxies")!.getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector('a[href="/settings/blur-faces"]')).not.toBeNull();
    expect(option("Copy to Media Library")).toBeUndefined();
    await add();
    expect(done).toHaveBeenCalledWith({ process: "blur", copy: true });
  });

  it("files from outside: Location in the same sheet, with Use where they are", async () => {
    const done = vi.fn();
    mount({ id: 2, count: 24, processes: ["proxies", "skip"], process: "proxies", outside: 3, done });
    expect(option("Generate blurred versions")).toBeUndefined();
    expect(document.body.textContent).toContain("3 of 24 files are outside Folder access.");
    expect(option("Copy to Media Library")!.getAttribute("aria-checked")).toBe("true");
    act(() => option("Skip processing")!.click());
    act(() => option("Use where they are")!.click());
    await add();
    expect(done).toHaveBeenCalledWith({ process: "skip", copy: false });
  });

  it("no processing to choose: only Location", () => {
    mount({ id: 3, count: 2, processes: [], process: "blur", outside: 2, done: vi.fn() });
    expect(document.body.textContent).not.toContain("Processing");
    expect(option("Use where they are")).toBeDefined();
  });
});

describe("the answer as an add's options", () => {
  const remote = { libraryBlurs: false, macRemote: true, onMac: false, hostsOriginals: false };
  it("Generate proxies asks for one; what is sent is the library's Upload", () => {
    expect(importOptions("proxies", remote)).toEqual({ mac: false, blur: false, asFilmed: false, askBlur: false, proxy: "yes" });
  });
  it("Skip processing: no proxy, and nothing sent where the library keeps only proxies", () => {
    expect(importOptions("skip", remote)).toMatchObject({ mac: true, proxy: "no" });
    // a library that keeps originals still gets the original
    expect(importOptions("skip", { ...remote, hostsOriginals: true })).toMatchObject({ mac: false, proxy: "no" });
  });
  it("Generate blurred versions where the library doesn't blur: indexed here and asked for, no proxy answer", () => {
    expect(importOptions("blur", remote)).toEqual({ mac: true, blur: true, asFilmed: false, askBlur: true });
  });
  it("not blurred where the library blurs: kept as filmed", () => {
    expect(importOptions("proxies", { ...remote, libraryBlurs: true, onMac: true })).toMatchObject({ mac: true, asFilmed: true });
  });
});
