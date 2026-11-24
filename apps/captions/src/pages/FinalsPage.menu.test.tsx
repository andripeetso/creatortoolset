// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { Piece } from "@contracts/library";
import { FinalsView } from "./FinalsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (n: number) => ({ id: `i${n}`, label: null, position: n, winner: n === 1, versionId: `v${n}`, externalRef: null, postDescription: null, postings: [] });
const piece = (id: string, writable?: boolean, versions = 0): Piece => ({
  id,
  label: `Tiny ${id}`,
  collectionId: "col_f",
  createdBy: "owner",
  items: Array.from({ length: versions }, (_, i) => item(i + 1)),
  ...(writable === undefined ? {} : { writable }),
});

const actionsWith = (onTrash: (p: Piece) => void) => ({ zipUrl: () => "/zip", onShare: vi.fn(), onPostLink: vi.fn(), onMerge: vi.fn(), onTrash });

async function rightClick(p: Piece, onTrash: (p: Piece) => void, others: Piece[] = []): Promise<string> {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <FinalsView hasFinals pieces={[p, ...others]} cards={[]} picked={{}} onFacets={() => {}} actions={actionsWith(onTrash)} />
      </MemoryRouter>,
    ),
  );
  const card = document.querySelector(`a[href="/finals/${p.id}"]`)!;
  await act(async () => void card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
  const menu = document.querySelector('[role="menu"]')?.textContent ?? "";
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes("Move to trash")) as HTMLElement | undefined;
  await act(async () => item?.click());
  act(() => root.unmount());
  host.remove();
  return menu;
}

describe("a Finals piece's right-click menu", () => {
  it("moves the piece to the trash", async () => {
    const onTrash = vi.fn();
    const menu = await rightClick(piece("a", true, 1), onTrash, [piece("c")]);
    for (const word of ["Open", "Download", "Share", "Add post link", "Merge piece", "Move to trash"]) expect(menu).toContain(word);
    expect(onTrash).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("offers no download, post link or merge where there is nothing to act on", async () => {
    const menu = await rightClick(piece("d"), vi.fn());
    expect(menu).not.toContain("Download");
    expect(menu).not.toContain("Add post link");
    expect(menu).not.toContain("Merge piece");
  });

  it("offers nothing on a piece the account may not change", async () => {
    const onTrash = vi.fn();
    expect(await rightClick(piece("b", false), onTrash)).toBe("");
    expect(onTrash).not.toHaveBeenCalled();
  });
});
