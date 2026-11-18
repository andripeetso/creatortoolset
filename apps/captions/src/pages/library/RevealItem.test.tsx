// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { AssetCard } from "@contracts/library";
import { RevealItem } from "./Selection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function menuFor(asset: Pick<AssetCard, "id" | "onComputer" | "placeWord">): Promise<string> {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <ContextMenu>
        <ContextMenuTrigger><div id="card">clip</div></ContextMenuTrigger>
        <ContextMenuContent><RevealItem libraryId="l1" asset={asset} onProblem={() => {}} /><span>Open</span></ContextMenuContent>
      </ContextMenu>,
    ),
  );
  await act(async () => void document.getElementById("card")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
  const text = document.querySelector('[role="menu"]')?.textContent ?? "";
  act(() => root.unmount());
  return text;
}

// A Tiny Acrobatics clip on a server elsewhere: Show in Finder only when this computer has its file.
describe("Show in Finder on a server elsewhere", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { hostname: "studio.example.com" });
    document.documentElement.dataset.macDevice = "dev_mine";
    document.documentElement.dataset.macReveal = "2";   // the Mac app with the reveal mark (TitleBar.swift)
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { thisMac: { postMessage: async () => ({}) } } };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.macDevice;
    delete document.documentElement.dataset.macReveal;
    delete (window as unknown as { webkit?: unknown }).webkit;
    document.body.innerHTML = "";
  });

  it("is not offered without the Mac app's reveal mark, even for a clip this computer has", async () => {
    delete document.documentElement.dataset.macReveal;
    const menu = await menuFor({ id: "a1", onComputer: true });
    expect(menu).toContain("Open");   // the menu opened, so the absence below means something
    expect(menu).not.toContain("Show in Finder");
  });

  it("is offered for an upload whose original this computer has", async () => {
    expect(await menuFor({ id: "a1", placeWord: { word: "here" } })).toContain("Show in Finder");
  });

  it("is not offered for \"here\" when this Mac has no id on the server (here then means any of the person's computers)", async () => {
    delete document.documentElement.dataset.macDevice;
    expect(await menuFor({ id: "a1", placeWord: { word: "here" } })).not.toContain("Show in Finder");
  });

  it("is offered for a clip read in place", async () => {
    expect(await menuFor({ id: "a1", onComputer: true })).toContain("Show in Finder");
  });

  it("is not offered for an upload only another computer has", async () => {
    const menu = await menuFor({ id: "a1", placeWord: { word: "on", computer: "Studio PC" } });
    expect(menu).toContain("Open");
    expect(menu).not.toContain("Show in Finder");
  });
});
