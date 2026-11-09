// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

// The Media Library page in a DOM, with a test plug-in that adds facets to it: the page reads them from webPlugins
// (library-slots.ts), so the plug-in's facet groups must show once the library has loaded. The server calls are stubbed.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../plugins.gen", () => ({
  webPlugins: [
    {
      id: "tiny",
      library: {
        facets: [
          { key: "tiny", label: "Tiny Facet", values: [{ value: "on", label: "Tiny on" }], scope: "both" },
          { key: "libonly", label: "Library Only Facet", values: [{ value: "x", label: "Library x" }], scope: "library" },
          { key: "finalsonly", label: "Finals Only Facet", values: [{ value: "f", label: "Finals f" }], scope: "finals" },
        ],
      },
    },
  ],
}));

vi.mock("@/lib/library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/library")>()),
  listLibraries: async () => [{ id: "lib_tiny", name: "Tiny", storage: "local", settings: {} }],
  listAssets: async () => ({ items: [], next: null }),
  listCollections: async () => [],
  listSources: async () => [],
}));

const { default: LibraryPage } = await import("./LibraryPage");

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  root = null;
});

/** Renders the page and waits for its first effects (the library load) to settle. */
async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return host;
}

describe("Media Library page with a plug-in facet", () => {
  it("draws the plug-in facet groups it is scoped to, and not the Finals-only one", async () => {
    const host = await mount();
    expect(host.querySelector('[role="group"][aria-label="Tiny Facet"]')).not.toBeNull();
    expect(host.querySelector('[role="group"][aria-label="Library Only Facet"]')).not.toBeNull();
    expect(host.querySelector('[role="group"][aria-label="Finals Only Facet"]')).toBeNull();
    expect(host.textContent).toContain("Tiny on");
  });

  it("a picked plug-in value toggles on its button", async () => {
    const host = await mount();
    const on = [...host.querySelectorAll("button")].find((b) => b.textContent === "Tiny on")!;
    expect(on.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      on.click();
    });
    expect(on.getAttribute("aria-pressed")).toBe("true");
  });
});
