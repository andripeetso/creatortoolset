// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ServerUpdateView } from "@contracts/server-update";
import { ServerUpdateSection, updateLine } from "./ServerUpdateSection";

// Settings → Storage → Update: what is waiting, Update now, and the same button held while the update runs.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const show = async (view: ServerUpdateView) => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const body = init?.method === "POST" && view.available ? { ...view, requested: true } : view;
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<ServerUpdateSection />));
  return { host, calls, button: () => host.querySelector("button") };
};

it("says the state in one line", () => {
  expect(updateLine({ behind: 0, failed: false })).toBe("Up to date");
  expect(updateLine({ behind: 1, failed: false })).toBe("1 change waiting");
  expect(updateLine({ behind: 14, failed: false })).toBe("14 changes waiting");
  expect(updateLine({ behind: 14, failed: true })).toBe("Update failed");
});

it("shows nothing on a server with no updater", async () => {
  expect((await show({ available: false })).host.textContent).toBe("");
});

it("shows what is waiting, and Update now asks once and holds the button while it runs", async () => {
  const s = await show({ available: true, behind: 14, nightly: 1_800_000_000, requested: false, waiting: false, failed: false });
  expect(s.host.textContent).toContain("14 changes waiting");
  expect(s.host.textContent).toContain("Every night at");
  expect(s.button()?.textContent).toBe("Update now");
  await act(async () => s.button()?.click());
  expect(s.calls).toEqual(["GET /api/server-update", "POST /api/server-update/request"]);
  expect(s.host.textContent).toContain("Updating");
  expect(s.button()?.disabled).toBe(true);
});

it("up to date has no button, and a failed update offers Retry", async () => {
  expect((await show({ available: true, behind: 0, nightly: null, requested: false, waiting: false, failed: false })).button()).toBeNull();
  const failed = await show({ available: true, behind: 2, nightly: null, requested: false, waiting: false, failed: true });
  expect(failed.host.textContent).toContain("Update failed");
  expect(failed.button()?.textContent).toBe("Retry");
});

it("says it waits for running work while it does", async () => {
  const s = await show({ available: true, behind: 3, nightly: null, requested: true, waiting: true, failed: false });
  expect(s.host.textContent).toContain("Waiting for running work");
  expect(s.button()?.disabled).toBe(true);
});
