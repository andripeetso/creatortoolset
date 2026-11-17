// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate, type NavigateFunction } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePageFollowsWorkspace } from "@/lib/page-workspace";
import { useWorkspace } from "@/lib/workspace";
import { ProjectSwitcher } from "./ProjectSwitcher";

// Switching workspace in the picker: a page that shows one thing of the old workspace leaves it for its tool's page
// (lib/page-workspace.ts, mounted once by App); a page of no one workspace stays.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let go: NavigateFunction;
let entries = 0;

function Page() {
  usePageFollowsWorkspace();
  go = useNavigate();
  const { pathname, search } = useLocation();
  return (
    <>
      <ProjectSwitcher />
      <output id="where">{pathname + search}</output>
    </>
  );
}

function open(path: string) {
  // each test on an entry of its own (the hook keeps a workspace per history entry)
  window.history.replaceState({ key: `t${++entries}`, idx: 0 }, "", path);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<BrowserRouter><Page /></BrowserRouter>));
}

const where = () => host!.querySelector("#where")!.textContent;

async function pick(name: string) {
  act(() => {
    host!.querySelector("button")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
  });
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent === name)!;
  await act(async () => { (item as HTMLElement).click(); });
}

beforeEach(() => {
  useWorkspace.setState({
    loaded: true,
    currentProjectId: "a",
    projects: [
      { id: "a", name: "Tiny Acrobatics", createdAt: 1 },
      { id: "b", name: "Tiny Acrobatics shop", createdAt: 2 },
    ] as ReturnType<typeof useWorkspace.getState>["projects"],
    select: async (id) => useWorkspace.setState({ currentProjectId: id }),
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
});

describe("the workspace picker's menu", () => {
  it("has the way to a new workspace: the form, not the list", () => {
    open("/");
    act(() => {
      host!.querySelector("button")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
    });
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.includes("New workspace"));
    expect(item?.getAttribute("href")).toBe("/projects?add=1");
  });
});

describe("switching workspace", () => {
  it("leaves a thing of the old workspace for its tool's page", async () => {
    open("/review/v1?c=9");
    await pick("Tiny Acrobatics shop");
    expect(useWorkspace.getState().currentProjectId).toBe("b");
    expect(where()).toBe("/review");
  });

  it("leaves a session for the Content Workshop's list, as its own picker did", async () => {
    open("/workshop/sessions/s1");
    await pick("Tiny Acrobatics shop");
    expect(where()).toBe("/workshop");
  });

  it("keeps a page of no one workspace", async () => {
    open("/");
    await pick("Tiny Acrobatics shop");
    expect(where()).toBe("/");
  });

  it("keeps a page opened together with the switch (a chat opened in chat mode brings its own page)", async () => {
    open("/review/v1");
    await act(async () => {
      go("/review/v2");
      void useWorkspace.getState().select("b");
    });
    expect(where()).toBe("/review/v2");
  });
});
