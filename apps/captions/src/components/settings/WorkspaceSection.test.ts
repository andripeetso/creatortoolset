// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberView, WorkspaceView } from "@contracts/workspaces";
import { useAuth } from "@/lib/auth";
import { clearLocalCache, putCached } from "@/lib/local-cache";
import { budgetFrom, memberLine, WorkspaceSection } from "./WorkspaceSection";

const member = (over: Partial<MemberView>): MemberView => ({
  username: "alex",
  role: "member",
  ai: "budget",
  budgetUsd: 25,
  joinedAt: 0,
  spentUsd: 14.2,
  lastActiveAt: 0,
  off: [],
  ...over,
});

describe("budgetFrom (the AI dialog's budget field)", () => {
  it("reads dollars, with $ and commas allowed, to the cent", () => {
    expect(budgetFrom("25")).toEqual({ ok: true, usd: 25 });
    expect(budgetFrom("$1,250.505")).toEqual({ ok: true, usd: 1250.51 });
  });

  it("refuses an empty, zero, tiny, huge or non-number budget", () => {
    for (const bad of ["", "  ", "0", "0.5", "10001", "ten"]) {
      expect(budgetFrom(bad)).toMatchObject({ ok: false });
    }
  });
});

describe("memberLine (the owner's row subtitle)", () => {
  it("shows the budget's spend and the cap on a budget member", () => {
    expect(memberLine(member({}), false, true)).toMatch(/^API budget \$14\.20 of \$25 this month · not signed in yet$/);
  });

  it("shows own AI for an owner's view, and nothing for another member's row", () => {
    expect(memberLine(member({ ai: "own" }), false, true)).toBe("Own AI · not signed in yet");
    expect(memberLine(member({}), false, false)).toBe("");
  });
});

describe("/settings/team?add=1 (the address of the Invite dialog)", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | undefined;
  let search = "";
  let writes: string[] = [];
  const Where = () => ((search = useLocation().search), null);

  /** Opens the address as `sam`, who is the team's owner or a member of it. */
  async function follow(role: WorkspaceView["me"]) {
    const team: WorkspaceView = {
      workspace: { id: "w1", name: "Tiny Acrobatics", plan: "team", comped: false, createdAt: 0 },
      me: role,
      members: [member({ username: "sam", role, ai: "own" })],
      invites: [],
      seats: 0,
    };
    writes = [];
    useAuth.setState({ required: true, me: { username: "sam", role: "team", cloud: false, off: [] } });
    putCached("sam", "/api/workspace", { team });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") writes.push(`${init.method} ${url}`);
      return new Response(JSON.stringify(String(url) === "/api/workspace" ? team : {}), { status: 200 });
    });
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => {
      root!.render(createElement(MemoryRouter, { initialEntries: ["/settings/team?add=1"] }, createElement(WorkspaceSection), createElement(Where)));
      await new Promise((done) => setTimeout(done, 0));
    });
  }

  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = "";
    clearLocalCache();
    vi.unstubAllGlobals();
  });

  it("opens Invite for the owner, drops the parameter and makes no link by itself", async () => {
    await follow("owner");
    expect(document.body.textContent).toContain("Invite someone");
    expect(document.body.textContent).toContain("Create link");
    expect(search).toBe("");
    expect(writes).toEqual([]);
  });

  it("shows a member the page as it is, with no dialog, and still drops the parameter", async () => {
    await follow("member");
    expect(document.body.textContent).toContain("Tiny Acrobatics");
    expect(document.body.textContent).not.toContain("Invite someone");
    expect(search).toBe("");
  });
});
