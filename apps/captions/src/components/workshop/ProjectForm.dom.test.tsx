// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ProjectForm } from "./ProjectForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Entry = { name: string; fullPath: string; isFile: boolean; isDirectory: boolean; file?: (ok: (f: File) => void) => void; createReader?: () => unknown };
const fileEntry = (f: File, dir = ""): Entry => ({ name: f.name, fullPath: `${dir}/${f.name}`, isFile: true, isDirectory: false, file: (ok) => ok(f) });
const folderEntry = (path: string, kids: Entry[]): Entry => {
  const left = [kids];
  return { name: path.split("/").pop()!, fullPath: path, isFile: false, isDirectory: true, createReader: () => ({ readEntries: (ok: (b: Entry[]) => void) => ok(left.shift() ?? []) }) };
};
/** A drop of these files or folders; the form opens it after the event, so it is awaited. */
const drop = async (el: Element, files: File[], entries: Entry[] = files.map((f) => fileEntry(f))) => {
  const e = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], files, items: entries.map((x) => ({ webkitGetAsEntry: () => x })) } });
  await act(async () => void el.dispatchEvent(e));
  return e;
};

vi.stubGlobal("fetch", () => new Promise(() => {}));

it("a file dropped on the instructions shows at the top of the box; saving keeps it for the project; a file it can't read is named", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const saved: unknown[] = [];
  act(() => root.render(<ProjectForm busy={false} onSave={(f, files) => void saved.push([f.name, files.map((k) => k.file.name)])} />));
  const notes = host.querySelector("#project-notes")!;
  expect(host.textContent).not.toContain("about.md");

  const e = await drop(notes, [new File(["We teach parents"], "about.md", { type: "text/markdown" })]);
  expect(e.defaultPrevented).toBe(true);
  expect(host.querySelector('[aria-label="Remove about.md"]')).toBeTruthy();

  const name = host.querySelector<HTMLInputElement>('input[required]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Tiny");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => void host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(saved).toEqual([["Tiny", ["about.md"]]]);

  await drop(notes, [new File(["x"], "clip.mov", { type: "video/quicktime" })]);
  expect(host.textContent).toContain("Can't read clip.mov");

  // a folder: its files and its folders' files come in, what it can't read (a picture, a hidden file) is left out quietly
  const brief = new File(["Sold in shops"], "brief.txt", { type: "text/plain" });
  const deep = new File(["Ages 0-3"], "audience.md", { type: "text/markdown" });
  const folder = folderEntry("/brand-kit", [
    fileEntry(brief, "/brand-kit"),
    fileEntry(new File(["x"], "logo.png", { type: "image/png" }), "/brand-kit"),
    fileEntry(new File(["x"], ".DS_Store"), "/brand-kit"),
    folderEntry("/brand-kit/more", [fileEntry(deep, "/brand-kit/more")]),
  ]);
  await drop(notes, [new File([""], "brand-kit")], [folder]);
  // one chip for the folder, its files by their paths
  expect(host.querySelector('[aria-label="Remove brand-kit"]')).toBeTruthy();
  expect(host.textContent).toContain("2 files");
  expect(host.querySelector('[aria-label="Remove brand-kit"]')!.parentElement!.title).toBe("brand-kit/more/audience.md\nbrand-kit/brief.txt");
  expect(host.textContent).not.toContain("logo.png");
  expect(host.textContent).not.toContain("Can't read");
  act(() => root.unmount());
  host.remove();
});
