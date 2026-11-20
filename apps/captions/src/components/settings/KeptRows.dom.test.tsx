// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { KeptView } from "@contracts/storage";

// Settings → Storage: each computer's proxies are a row with their size and Empty, which empties only that computer.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/local-cache", () => ({
  useCachedLoad: <T,>(_key: string, load: () => Promise<T>) => {
    const [data, setData] = useState<T>();
    const [n, setN] = useState(0);
    useEffect(() => void load().then(setData, () => {}), [n]);
    return { data, error: undefined, refresh: async () => setN((x) => x + 1) };
  },
}));
vi.mock("@/lib/dialogs", () => ({ confirmDialog: vi.fn(async () => true) }));
const { KeptSection, RenderCacheSection } = await import("./KeptRows");
const { confirmDialog } = await import("@/lib/dialogs");

it("a computer's proxies: its name, size and clips, and Empty for that computer", async () => {
  const view: KeptView = {
    here: false,
    rows: [
      { kind: "review", bytes: 2_000_000, items: 1 },
      { kind: "proxies", bytes: 3_400_000_000, items: 12, device: { id: "dev_mac", name: "Studio Mac" } },
      { kind: "proxies", bytes: 0, items: 0, device: { id: "dev_pc", name: "Edit PC" } },
    ],
  };
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify(view), { headers: { "content-type": "application/json" } });
    }),
  );
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<KeptSection />));
  expect(host.textContent).toContain("Proxies on Studio Mac");
  expect(host.textContent).toContain("3.4 GB · 12 clips");
  expect(host.textContent).not.toContain("Edit PC"); // nothing kept there
  const empty = [...host.querySelectorAll("button")].find((b) => b.textContent === "Empty")!;
  await act(async () => empty.click());
  expect(vi.mocked(confirmDialog).mock.calls[0]![0]).toMatchObject({
    title: "Delete the proxies of 12 clips on Studio Mac?",
    body: "Clips kept offline are not deleted.",
  });
  expect(urls).toContain("POST /api/devices/storage/kept/proxies/empty?device=dev_mac");
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("the render cache: its size and Clear, which asks first; nothing where the server keeps none", async () => {
  const urls: string[] = [];
  let bytes = 4_200_000_000;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST") bytes = 0;
      return new Response(JSON.stringify({ bytes, limit: 20e9, folders: 1 }), { headers: { "content-type": "application/json" } });
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<RenderCacheSection />));
  expect(host.textContent).toContain("Render cache");
  expect(host.textContent).toContain("4.2 GB");
  const clear = [...host.querySelectorAll("button")].find((b) => b.textContent === "Clear")!;
  await act(async () => clear.click());
  expect(vi.mocked(confirmDialog).mock.calls.at(-1)![0]).toMatchObject({ title: "Clear the render cache?", ok: "Delete 4.2 GB", danger: true });
  expect(urls).toContain("POST /api/editor/render-cache/clear");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Clear")).toBe(false); // nothing left to clear
  act(() => root.unmount());

  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "content-type": "application/json" } })));
  const none = createRoot(host);
  await act(async () => none.render(<RenderCacheSection />));
  expect(host.textContent).toBe("");
  act(() => none.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
