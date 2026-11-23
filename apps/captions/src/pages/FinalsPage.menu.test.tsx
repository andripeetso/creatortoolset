// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { Piece } from "@contracts/library";
import { FinalsView } from "./FinalsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const piece = (id: string, writable?: boolean): Piece => ({ id, label: `Tiny ${id}`, collectionId: "col_f", createdBy: "owner", items: [], ...(writable === undefined ? {} : { writable }) });

async function rightClick(p: Piece, onTrash: (p: Piece) => void): Promise<string> {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <FinalsView hasFinals pieces={[p]} cards={[]} picked={{}} onFacets={() => {}} onTrash={onTrash} />
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
    expect(await rightClick(piece("a"), onTrash)).toContain("Move to trash");
    expect(onTrash).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("offers nothing on a piece the account may not change", async () => {
    const onTrash = vi.fn();
    expect(await rightClick(piece("b", false), onTrash)).toBe("");
    expect(onTrash).not.toHaveBeenCalled();
  });
});
