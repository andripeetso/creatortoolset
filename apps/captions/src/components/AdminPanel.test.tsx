// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAuth } from "@/lib/auth";
import { clearLocalCache, putCached } from "@/lib/local-cache";
import { AdminPanel, type AdminTab } from "./AdminPanel";

// Admin's lists come from their saved copies: there on the first paint, and still there when the server can't be reached.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const account = { username: "tinyacrobatics", role: "team", off: [], createdAt: 1, usage: { logins: 3, lastActiveAt: 0 }, projects: 2, storageBytes: 0 };
const project = { id: "p1", kind: "captions", name: "Tiny Acrobatics reel", owner: "tinyacrobatics", createdAt: 1, updatedAt: 2, bytes: 0 };
let online: boolean;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));
/** Opens a tab; what it returns is the first paint (the reads have started and not answered). */
function open(tab: AdminTab): string {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<AdminPanel tab={tab} />));
  return host.textContent ?? "";
}
const now = () => host?.textContent ?? "";

beforeEach(() => {
  online = true;
  useAuth.setState({ me: { username: "tinyadmin", role: "admin" } as never });
  vi.stubGlobal("fetch", async (url: string) => {
    if (!online) throw new TypeError("Load failed");
    return new Response(JSON.stringify(String(url).endsWith("/projects") ? [project] : [account]), { status: 200 });
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  clearLocalCache();
  vi.unstubAllGlobals();
});

it("shows a loading row only on a device with nothing saved, then the rows", async () => {
  expect(open("users")).toContain("Loading…");
  await flush();
  expect(now()).toContain("tinyacrobatics");
  expect(now()).not.toContain("Loading…");
});

it("paints the saved rows on the first paint of every tab, with no loading row", () => {
  putCached("tinyadmin", "/api/admin/users", [account]);
  putCached("tinyadmin", "/api/admin/projects", [project]);
  for (const [tab, row] of [["users", "tinyacrobatics"], ["access", "tinyacrobatics"], ["projects", "Tiny Acrobatics reel"]] as const) {
    const first = open(tab);
    expect(first).toContain(row);
    expect(first).not.toContain("Loading…");
    act(() => root!.unmount());
    host!.remove();
    root = undefined;
  }
});

it("keeps the saved rows when the server can't be reached, and says the list did not load only when there is nothing to show", async () => {
  online = false;
  putCached("tinyadmin", "/api/admin/users", [account]);
  open("users");
  await flush();
  expect(now()).toContain("tinyacrobatics");
  expect(now()).not.toContain("did not load");
  act(() => root!.unmount());
  host!.remove();
  root = undefined;
  clearLocalCache();
  open("users");
  await flush();
  expect(now()).toContain("The accounts did not load.");
});
