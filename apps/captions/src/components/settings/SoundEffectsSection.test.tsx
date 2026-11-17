// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { SoundEffectsSection, type SfxState } from "./SoundEffectsSection";

// Settings → Sound effects: the library's count and folder, the starter set's Install and Remove, and the sources.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state: SfxState = {
  library: "lib_1",
  count: 51,
  folder: "col_1",
  starter: { total: 51, installed: 51 },
  packs: [{ name: "Impact Sounds", source: "https://kenney.nl/assets/impact-sounds", license: "CC0", licenseFile: "licenses/impact-sounds-LICENSE.txt" }],
  available: true,
};

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

const show = async (s: SfxState) => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify(init?.method === "POST" ? { added: 0, already: 51, failed: 0 } : s), { headers: { "content-type": "application/json" } });
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SoundEffectsSection />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return { calls, text: host.textContent ?? "", root };
};

it("shows the library count, a link to its folder, and the starter set as installed", async () => {
  const { text, root } = await show(state);
  expect(text).toContain("51 sounds");
  expect(text).toContain("Open folder");
  expect(text).toContain("Installed 51 of 51");
  expect(text).toContain("Remove");
  expect(text).not.toMatch(/Install(?!ed)/);
  expect(text).toContain("Impact Sounds");
  expect(text).toContain("CC0 licence");
  await act(async () => root.unmount());
});

it("offers Install when the starter set is not all in, and sends the request for the shown workspace", async () => {
  const { calls, text, root } = await show({ ...state, count: 0, starter: { total: 51, installed: 0 } });
  expect(text).toContain("0 sounds");
  expect(text).toContain("Install");
  expect(text).not.toContain("Remove");
  expect(calls[0]).toBe("GET /api/sfx");
  await act(async () => root.unmount());
});
