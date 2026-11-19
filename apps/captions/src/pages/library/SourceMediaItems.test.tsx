// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The Library ⋯ menu's Show Source media in Finder (only this Mac's folders Finder can show) and Look for new files.
const h = vi.hoisted(() => ({ folders: [] as object[], revealed: [] as string[] }));
vi.mock("@/lib/local-cache", () => ({ useCachedLoad: () => ({ data: { folders: h.folders } }) }));
vi.mock("@/components/settings/StorageRows", () => ({
  STORAGE_API: "/api/devices/storage",
  call: async () => ({ folders: h.folders }),
  canRevealFolder: (f?: { mine?: boolean }) => !!f?.mine,
  revealFolder: async (f: { origin: { path: string } }) => void h.revealed.push(f.origin.path),
}));
const { SourceMediaItems } = await import("./SourceMediaItems");

const folder = (id: string, name: string, extra: object = {}) => ({ id, role: "footage", name, origin: { host: "mac", path: `/Volumes/Tiny/${name}` }, workspace: "*", mine: true, ...extra });
let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  document.body.innerHTML = "";
  h.folders = [];
  h.revealed = [];
});
const open = (canLook: boolean, onLook = () => {}) => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <DropdownMenu open>
        <DropdownMenuTrigger>More</DropdownMenuTrigger>
        <DropdownMenuContent>
          <SourceMediaItems canLook={canLook} onLook={onLook} onError={() => {}} />
        </DropdownMenuContent>
      </DropdownMenu>,
    ),
  );
};
const item = (text: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((x) => x.textContent?.includes(text));

describe("the Library menu's Source media items", () => {
  it("one Source media folder Finder can show: Show Source media in Finder opens it", async () => {
    h.folders = [folder("a", "FOOTAGE")];
    open(false);
    await act(async () => item("Show Source media in Finder")!.click());
    expect(h.revealed).toEqual(["/Volumes/Tiny/FOOTAGE"]);
  });
  it("several are a submenu; folders Finder can't show here (another computer's) and other uses are left out", () => {
    h.folders = [folder("a", "FOOTAGE"), folder("b", "B-ROLL"), folder("c", "ELSEWHERE", { mine: false }), folder("d", "EXPORTS", { role: "library" })];
    open(false);
    const trigger = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.getAttribute("aria-haspopup") === "menu");
    expect(trigger?.textContent).toContain("Show Source media in Finder");
  });
  it("none Finder can show: no item; Look for new files only where it may run, and it runs", async () => {
    h.folders = [folder("c", "ELSEWHERE", { mine: false })];
    const look = vi.fn();
    open(false);
    expect(item("Show Source media in Finder")).toBeUndefined();
    expect(item("Look for new files")).toBeUndefined();
    act(() => root!.unmount());
    root = undefined;
    document.body.innerHTML = "";
    open(true, look);
    await act(async () => item("Look for new files")!.click());
    expect(look).toHaveBeenCalledTimes(1);
  });
});
