// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberView, WorkspaceView } from "@contracts/workspaces";
import { useAuth } from "@/lib/auth";
import { clearLocalCache, putCached } from "@/lib/local-cache";
import { budgetFrom, memberLine, worksIn, WorkspaceSection, WorkspacesDialog } from "./WorkspaceSection";

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
    expect(memberLine(member({}), false, true)).toMatch(/^Team budget \$14\.20 of \$25 this month · never signed in$/);
  });

  it("says the same for the person's own row as for anyone's, and nothing for another member's row", () => {
    expect(memberLine(member({ ai: "own" }), false, true)).toBe("Own AI provider · never signed in");
    expect(memberLine(member({ ai: "own" }), true, false)).toBe("Own AI provider · never signed in");
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
  async function follow(role: WorkspaceView["me"], more: Partial<WorkspaceView> = {}, address = "/settings/team?add=1", accounts?: unknown[]) {
    const team: WorkspaceView = {
      workspace: { id: "w1", name: "Tiny Acrobatics", plan: "team", comped: false, createdAt: 0 },
      me: role,
      members: [member({ username: "sam", role, ai: "own" })],
      invites: [],
      seats: 0,
      ...more,
    };
    writes = [];
    // `accounts`: sam is a platform admin, and these are the server's accounts
    useAuth.setState({ required: true, me: { username: "sam", role: accounts ? "admin" : "team", cloud: false, off: [] } });
    putCached("sam", "/api/workspace", { team });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") writes.push(`${init.method} ${url}`);
      return new Response(JSON.stringify(String(url) === "/api/workspace" ? team : String(url) === "/api/admin/users" ? (accounts ?? []) : {}), { status: 200 });
    });
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => {
      root!.render(createElement(MemoryRouter, { initialEntries: [address] }, createElement(WorkspaceSection), createElement(Where)));
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
    expect(document.body.textContent).toContain("New invite");
    expect(document.body.textContent).toContain("Create link");
    expect(search).toBe("");
    expect(writes).toEqual([]);
  });

  it("shows a member the page as it is, with no dialog, and still drops the parameter", async () => {
    await follow("member");
    expect(document.querySelector("h2")?.textContent).toBe("Team");
    expect(document.body.textContent).toContain("Tiny Acrobatics · Own AI provider");
    expect(document.body.textContent).not.toContain("New invite");
    expect(search).toBe("");
  });

  it("a member's row and an invite's row have one control each, the menu, and say the workspaces in words", async () => {
    await follow(
      "owner",
      {
        members: [member({ username: "sam", role: "owner", ai: "own" }), member({ username: "alex", ai: "own", workspaces: ["b1"] })],
        invites: [{ id: "i1", workspaceId: "w1", ai: "own", budgetUsd: 0, createdBy: "sam", createdAt: 0, expiresAt: 86_400_000, email: "kim@tinyacrobatics.example", workspaces: ["b1", "b2"] }],
        brands: [{ id: "b1", name: "Tiny Acrobatics" }, { id: "b2", name: "Tiny Tumblers" }],
      },
      "/settings/team",
    );
    const row = (text: string) => [...document.querySelectorAll("div.grid")].find((r) => r.textContent?.includes(text))!;
    expect([...row("alex").querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["More for alex"]);
    expect(row("alex").textContent).toContain("Own AI provider · never signed in · Tiny Acrobatics");
    expect([...row("kim@").querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["More for kim@tinyacrobatics.example"]);
    expect(row("kim@").textContent).toContain("2 workspaces");
    // the owner who is no admin has no accounts to run
    expect([...document.querySelectorAll("h2")].map((h) => h.textContent)).not.toContain("Accounts");
  });

  it("an admin runs every account in one place: Accounts, with New account, each account once and no menu on their own", async () => {
    const account = (username: string, role = "user") => ({ username, role, off: [], createdAt: 0, usage: { logins: 0, lastActiveAt: 0 }, projects: 0, storageBytes: 0 });
    await follow(
      "owner",
      { members: [member({ username: "sam", role: "owner", ai: "own" }), member({ username: "alex", ai: "own" })] },
      "/settings/team",
      [account("sam", "admin"), account("alex"), account("robin")],
    );
    const sections = [...document.querySelectorAll("section")];
    const titled = (title: string) => sections.find((s) => s.querySelector("h2")?.textContent === title)!;
    const labels = (el: Element) => [...el.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
    expect(labels(titled("Members"))).toEqual(["Invite", "More for alex"]);
    expect(labels(titled("Accounts"))).toEqual(["New account", "More for alex", "More for robin"]);
    expect(titled("Accounts").textContent).toContain("samAdmin · never signed in");
    expect(sections.map((s) => s.querySelector("h2")?.textContent)).not.toContain("Other accounts");
  });
});

describe("worksIn (the workspaces in a person's row)", () => {
  const brands = [{ id: "b1", name: "Tiny Acrobatics" }, { id: "b2", name: "Tiny Tumblers" }];
  it("is the one's name, how many for more, and nothing for none or for a workspace the owner no longer has", () => {
    expect(worksIn(brands, ["b2"])).toBe("Tiny Tumblers");
    expect(worksIn(brands, ["b1", "b2"])).toBe("2 workspaces");
    expect(worksIn(brands, [])).toBeNull();
    expect(worksIn(brands, ["old"])).toBeNull();
    expect(worksIn(brands)).toBeNull();
  });
});

describe("Workspaces… (a member's or an invite's workspaces, from the row's menu)", () => {
  let root: Root | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = "";
  });

  it("has one switch per workspace, on for the ones given, saves each switch at once, and Done closes", async () => {
    const saved: string[][] = [];
    let closed = false;
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root!.render(
        createElement(WorkspacesDialog, {
          who: "alex",
          brands: [{ id: "b1", name: "Tiny Acrobatics" }, { id: "b2", name: "Tiny Tumblers" }],
          given: ["b1", "old"],
          onClose: () => (closed = true),
          onSave: async (ids: string[]) => void saved.push(ids),
        }),
      ),
    );
    expect(document.body.textContent).toContain("Workspaces for alex");
    const switches = [...document.querySelectorAll<HTMLElement>('[role="switch"]')];
    expect(switches.map((s) => [s.getAttribute("aria-label"), s.getAttribute("aria-checked")])).toEqual([
      ["Tiny Acrobatics for alex", "true"],
      ["Tiny Tumblers for alex", "false"],
    ]);
    await act(async () => switches[1]!.click());
    expect(saved).toEqual([["b1", "b2"]]);
    expect(closed).toBe(false);
    expect([...document.querySelectorAll("button")].map((b) => b.textContent).filter((t) => t === "Save" || t === "Cancel")).toEqual([]);
    await act(async () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Done")!.click());
    expect(closed).toBe(true);
  });
});
