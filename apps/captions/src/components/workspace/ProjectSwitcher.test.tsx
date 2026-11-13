// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatMode } from "@/lib/chat-mode";
import { useWorkspace } from "@/lib/workspace";
import { ProjectSwitcher } from "./ProjectSwitcher";

// In chat mode the picker under the chats stands in for the page's own (hidden then): it does what the page's would
// have done, once, and nothing to a page that is not drawn.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const pageDoes = vi.fn();

beforeEach(() => {
  pageDoes.mockClear();
  useWorkspace.setState({
    loaded: true,
    currentProjectId: "a",
    projects: [
      { id: "a", name: "Tiny Acrobatics", createdAt: 1 },
      { id: "b", name: "Tiny Acrobatics shop", createdAt: 2 },
    ] as ReturnType<typeof useWorkspace.getState>["projects"],
    select: async (id) => useWorkspace.setState({ currentProjectId: id }),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter>
        <div id="page"><ProjectSwitcher onSelect={pageDoes} /></div>
        <div id="frame"><ProjectSwitcher frame /></div>
      </MemoryRouter>,
    ),
  );
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  useChatMode.setState({ pane: null });
});

async function pick(from: "page" | "frame", name: string) {
  act(() => {
    host!.querySelector(`#${from} button`)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
  });
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent === name)!;
  await act(async () => { (item as HTMLElement).click(); });
}

describe("the project picker's menu", () => {
  it("has the way to a new project: the form, not the list", () => {
    act(() => {
      host!.querySelector("#frame button")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
    });
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.includes("New project"));
    expect(item?.getAttribute("href")).toBe("/projects?add=1");
  });
});

describe("the project picker under the chats", () => {
  it("does what the page's own picker does, once", async () => {
    useChatMode.setState({ pane: 700 });
    await pick("frame", "Tiny Acrobatics shop");
    expect(useWorkspace.getState().currentProjectId).toBe("b");
    expect(pageDoes.mock.calls).toEqual([["b"]]);
  });

  it("does nothing to a page that is not drawn (only chats)", async () => {
    useChatMode.setState({ pane: 0 });
    await pick("frame", "Tiny Acrobatics shop");
    expect(useWorkspace.getState().currentProjectId).toBe("b");
    expect(pageDoes).not.toHaveBeenCalled();
  });

  it("leaves the page's own picker as it was: its own action, once", async () => {
    await pick("page", "Tiny Acrobatics shop");
    expect(pageDoes.mock.calls).toEqual([["b"]]);
  });
});
