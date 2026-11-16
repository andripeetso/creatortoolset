// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAuth } from "@/lib/auth";
import { clearLocalCache, putCached } from "@/lib/local-cache";
import { ServerProjects } from "./AdminPanel";

// The server's project list (Settings → Storage, admins) comes from its saved copy: there on the first paint, and still
// there when the server can't be reached.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = { id: "p1", kind: "captions", name: "Tiny Acrobatics reel", owner: "tinyacrobatics", createdAt: 1, updatedAt: 2, bytes: 0 };
let online: boolean;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

const flush = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));
/** Draws the list; what it returns is the first paint (the read has started and not answered). */
function open(): string {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<ServerProjects />));
  return host.textContent ?? "";
}
const now = () => host?.textContent ?? "";

beforeEach(() => {
  online = true;
  useAuth.setState({ me: { username: "tinyadmin", role: "admin" } as never });
  vi.stubGlobal("fetch", async (url: string) => {
    if (!online) throw new TypeError("Load failed");
    void url;
    return new Response(JSON.stringify([project]), { status: 200 });
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
  expect(open()).toContain("Loading…");
  await flush();
  expect(now()).toContain("Tiny Acrobatics reel");
  expect(now()).not.toContain("Loading…");
});

it("a row says the project's tool, owner and when it changed", async () => {
  open();
  await flush();
  expect(now()).toContain("Caption Studio · tinyacrobatics · updated ");
});

it("paints the saved rows on the first paint, with no loading row", () => {
  putCached("tinyadmin", "/api/admin/projects", [project]);
  const first = open();
  expect(first).toContain("Tiny Acrobatics reel");
  expect(first).not.toContain("Loading…");
});

it("keeps the saved rows when the server can't be reached, and says the list could not load only when there is nothing to show", async () => {
  online = false;
  putCached("tinyadmin", "/api/admin/projects", [project]);
  open();
  await flush();
  expect(now()).toContain("Tiny Acrobatics reel");
  expect(now()).not.toContain("Could not load");
  act(() => root!.unmount());
  host!.remove();
  root = undefined;
  clearLocalCache();
  open();
  await flush();
  expect(now()).toContain("Could not load projects");
});
