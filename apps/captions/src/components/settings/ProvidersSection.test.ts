// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProvidersView } from "@contracts/providers";
import { useAuth } from "@/lib/auth";
import { clearLocalCache, putCached } from "@/lib/local-cache";
import { ProvidersSection, shortVersion } from "./ProvidersSection";

describe("shortVersion", () => {
  it("keeps the number a person reads from what each tool prints", () => {
    expect(shortVersion("2.1.321 (Claude Code)")).toBe("2.1.321");
    expect(shortVersion("codex-cli 0.39.0")).toBe("0.39.0");
    expect(shortVersion("grok 1.0.4 (d846eb93d94d)")).toBe("1.0.4");
    expect(shortVersion("1.18.31")).toBe("1.18.31");
  });

  it("leaves a version with no number, or none at all, as it is", () => {
    expect(shortVersion("nightly")).toBe("nightly");
    expect(shortVersion(undefined)).toBeUndefined();
  });
});

describe("/settings/providers?add=1 (the address of the Add provider dialog)", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | undefined;
  let search = "";
  let writes: string[] = [];
  const Where = () => ((search = useLocation().search), null);
  const mac = { id: "d1", owner: "sam", name: "Sam's Mac", createdAt: 0, lastSeen: 0, online: true, report: { at: 1, drivers: [], homes: [] } };

  /** Opens the address as `sam` with these computers; an admin edits the team's set, a member with no set of their own only reads. */
  async function follow(role: "admin" | "team", devices: unknown[]) {
    const view = { workspace: { settings: { instances: [], default: { instance: "" }, jobs: {} }, editable: role === "admin" }, own: null, using: "none", devices, checks: {}, models: {}, usage: [], limits: [] } as unknown as ProvidersView;
    writes = [];
    useAuth.setState({ required: true, me: { username: "sam", role, cloud: false, off: [] } });
    putCached("sam", "/api/providers", view);
    putCached("sam", "/api/setup/ai", { local: false, rows: [] });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") writes.push(`${init.method} ${url}`);
      const body = String(url) === "/api/providers" ? view : String(url) === "/api/setup/ai" ? { local: false, rows: [] } : { drivers: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => {
      root!.render(createElement(MemoryRouter, { initialEntries: ["/settings/providers?add=1"] }, createElement(ProvidersSection, {}), createElement(Where)));
      await new Promise((done) => setTimeout(done, 0));
    });
  }
  const dialog = () => document.body.querySelector('[role="dialog"]')?.textContent ?? "";

  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = "";
    clearLocalCache();
    vi.unstubAllGlobals();
  });

  it("opens Add provider on the computer, drops the parameter and adds nothing by itself", async () => {
    await follow("admin", [mac]);
    expect(dialog()).toContain("Add provider");
    expect(search).toBe("");
    expect(writes).toEqual([]);
  });

  it("with no computer shows the page as it is and stays on it", async () => {
    await follow("admin", []);
    expect(document.body.textContent).toContain("No computer connected");
    expect(dialog()).toBe("");
    expect(search).toBe("");
  });

  it("opens nothing for a member who only reads the team's AI", async () => {
    await follow("team", [mac]);
    expect(dialog()).toBe("");
    expect(search).toBe("");
  });
});
