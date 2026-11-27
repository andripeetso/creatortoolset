// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { Piece } from "@contracts/library";
import { FinalsView, type PieceActions } from "./FinalsPage";

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

const actionsWith = (onTrash: (p: Piece) => void, onMerge = vi.fn(), onPosted = vi.fn()) => ({ zipUrl: () => "/zip", onShare: vi.fn(), onPostLink: vi.fn(), onPosted, onMerge, onTrash });

/** Right-clicks `p`, reads the menu, then clicks the item that says `click`. No `actions`: a library this account only looks at. */
async function rightClick(p: Piece, actions: PieceActions | undefined, others: Piece[] = [], click = "Move to trash"): Promise<string> {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <FinalsView hasFinals pieces={[p, ...others]} cards={[]} picked={{}} onFacets={() => {}} actions={actions} />
      </MemoryRouter>,
    ),
  );
  const card = document.querySelector(`a[href="/finals/${p.id}"]`)!;
  await act(async () => void card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
  const menu = document.querySelector('[role="menu"]')?.textContent ?? "";
  const find = (word: string) => [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes(word)) as HTMLElement | undefined;
  const sub = find("Merge piece");
  if (click !== "Move to trash" && sub) await act(async () => void sub.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  await act(async () => find(click)?.click());
  act(() => root.unmount());
  host.remove();
  return menu;
}

describe("a Finals piece's right-click menu", () => {
  it("moves the piece to the trash", async () => {
    const onTrash = vi.fn();
    const menu = await rightClick(piece("a", true, 1), actionsWith(onTrash), [piece("c")]);
    for (const word of ["Open", "Download", "Share", "Add post link", "Merge piece", "Move to trash"]) expect(menu).toContain(word);
    expect(onTrash).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("offers no download, post link or merge where there is nothing to act on", async () => {
    const menu = await rightClick(piece("d"), actionsWith(vi.fn()));
    expect(menu).not.toContain("Download");
    expect(menu).not.toContain("Add post link");
    expect(menu).not.toContain("Merge piece");
  });

  it("merges the picked piece into the one right-clicked, never the other way", async () => {
    const onMerge = vi.fn();
    await rightClick(piece("a", true, 1), actionsWith(vi.fn(), onMerge), [piece("c", true, 1)], "Tiny c");
    expect(onMerge).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), expect.objectContaining({ id: "c" }));
  });

  it("marks a piece that is not posted as posted, and offers it no more once it is", async () => {
    const onPosted = vi.fn();
    await rightClick(piece("a", true, 1), actionsWith(vi.fn(), vi.fn(), onPosted), [], "Mark as posted");
    expect(onPosted).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    const posted = piece("p", true, 1);
    posted.items[0].postings = [{ id: 1, platform: "instagram", url: null, postedAt: 1, createdBy: "owner" }];
    expect(await rightClick(posted, actionsWith(vi.fn()))).not.toContain("Mark as posted");
  });

  it("offers nothing in a library the account only looks at", async () => {
    expect(await rightClick(piece("b", true, 1), undefined)).toBe("");
  });
});
