// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ServerWorkView } from "@contracts/work";
import { WorkspacePoliciesSection } from "./WorkspacePoliciesSection";

// Settings → Workspace policies: the master switch, All workspaces and one switch per workspace, by server kind.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const show = async (view: ServerWorkView) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(view), { headers: { "content-type": "application/json" } })));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<WorkspacePoliciesSection />));
  const switches = () => [...host.querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
  return { text: () => host.textContent ?? "", switches };
};

const admin = {
  on: true,
  offByUpdate: false,
  all: false,
  workspaces: [
    { id: "ws-a", name: "Tiny Acrobatics", owner: "boss", on: true },
    { id: "ws-b", name: "Second Brand", owner: "boss", on: false },
  ],
};

it("a server by address: the master, All workspaces, then one switch per workspace", async () => {
  const { text, switches } = await show({ kind: "server", place: null, serverName: "boss's server", admin });
  expect(text()).toContain("Server rendering");
  expect(text()).toContain("All workspaces");
  expect(text()).toContain("Tiny Acrobatics");
  expect(text()).toContain("Second Brand");
  expect(switches().map((b) => b.getAttribute("aria-label"))).toEqual([
    "Server rendering",
    "All workspaces",
    "Server rendering for Tiny Acrobatics",
    "Server rendering for Second Brand",
  ]);
  expect(switches().every((b) => !b.disabled)).toBe(true);
});

it("All workspaces on hides the per-workspace switches", async () => {
  const { text } = await show({ kind: "server", place: null, admin: { ...admin, all: true } });
  expect(text()).toContain("All workspaces");
  expect(text()).not.toContain("Second Brand");
});

it("This Mac: the master is on and disabled, with its status, and there is no list", async () => {
  const { text, switches } = await show({ kind: "local", place: null });
  expect(text()).toContain("This Mac does all video work");
  expect(switches()).toHaveLength(1);
  expect(switches()[0]!.disabled).toBe(true);
  expect(switches()[0]!.getAttribute("aria-checked")).toBe("true");
});

it("Creator Toolset Cloud: the master is read-only and there are no per-workspace rows", async () => {
  const { text, switches } = await show({ kind: "hosted", place: { allowed: true, weight: 50 }, serverName: "Creator Toolset Cloud" });
  expect(text()).not.toContain("All workspaces");
  expect(switches()).toHaveLength(1);
  expect(switches()[0]!.disabled).toBe(true);
});
