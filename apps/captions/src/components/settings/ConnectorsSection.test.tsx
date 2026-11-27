// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/lib/auth";
import { clearLocalCache, putCached } from "@/lib/local-cache";
import { useWorkspace } from "@/lib/workspace";
import { ConnectorsSection, everyRow, missingWithoutSignIn, newestSignIn, platformRows, signedInSince, signInItems } from "./ConnectorsSection";
import type { ConnectedAccount, ConnectorsView } from "@contracts/connectors";

it("offers only the sign-ins this server has an app for", () => {
  expect(signInItems({ meta: false, google: true, tiktok: false })).toEqual([{ id: "google", label: "YouTube" }]);
  expect(signInItems({ meta: false, google: false, tiktok: false })).toEqual([]);
});

const none = { meta: false, google: false, tiktok: false };
const acct = (platform: ConnectedAccount["platform"], handle: string, projectId?: string): ConnectedAccount => ({ key: `${platform}:${handle}`, platform, platformId: handle, handle, via: "apify", connectedAt: 0, projectId, stats: { followers: 4120 } });
const view = (o: Partial<Pick<ConnectorsView, "logins" | "apify" | "accounts" | "instagram">>) => ({ logins: none, apify: { configured: true, valid: true }, accounts: [], instagram: [], ...o });
const row = (rows: ReturnType<typeof platformRows>, id: string) => rows.find((r) => r.platform === id);

it("a tool's setup form offers a sign-in only where this server has its own app: one the sign-in service would give is left out", () => {
  const all = { meta: true, google: true, tiktok: true };
  expect(signInItems(all, ["google", "tiktok"]).map((s) => s.id)).toEqual(["meta"]);
  // the downloaded app on a person's computer has no app of its own: the form is the Apify key alone
  expect(signInItems(all, ["meta", "google", "tiktok"])).toEqual([]);
});

it("the platform list: each platform the app has a sign-in for, with its account or Add (sign-in or a handle, chosen in the dialog); X has none, so no Add", () => {
  const rows = platformRows(view({ instagram: [{ id: "a1", handle: "tinyacrobatics", followers: 4120, mine: true, signedIn: false }] }));
  expect(row(rows, "instagram")).toMatchObject({ summary: "@tinyacrobatics · 4,120 followers", own: { id: "a1" } });
  expect(row(rows, "instagram")?.button).toBeUndefined();
  // with or without this server's sign-ins, each of the four with no account has Add
  for (const logins of [none, { meta: true, google: true, tiktok: true }]) {
    expect(platformRows(view({ logins })).map((r) => [r.platform, r.button])).toEqual([
      ["instagram", "Add"],
      ["facebook", "Add"],
      ["youtube", "Add"],
      ["tiktok", "Add"],
    ]);
  }
});

it("an account not signed in to says what the platform's sign-in adds", () => {
  expect(missingWithoutSignIn("instagram")).toMatch(/^Public posts only\. Signing in adds insights, reach, saves/);
  expect(missingWithoutSignIn("x")).toBe("Public posts only");
});

it("each project shows its own account per platform; an account in no project shows until one is linked", () => {
  const accounts = [acct("tiktok", "brand-a", "p1"), acct("tiktok", "brand-b", "p2"), acct("youtube", "old"), acct("x", "tinyx", "p2")];
  const p1 = platformRows(view({ accounts }), "p1");
  expect(row(p1, "tiktok")).toMatchObject({ summary: "@brand-a · 4,120 followers" });
  expect(row(p1, "tiktok")?.button).toBeUndefined();
  expect(row(platformRows(view({ accounts }), "p2"), "tiktok")?.account?.handle).toBe("brand-b");
  expect(row(p1, "youtube")?.account?.handle).toBe("old");
  // an account already there keeps its row, sign-in or not
  expect(row(platformRows(view({ accounts }), "p2"), "x")?.account?.handle).toBe("tinyx");
  expect(row(p1, "x")).toBeUndefined(); // and is not offered where there is none
});

it("Instagram follows the project: the account a project links, else the one marked Mine that no project links", () => {
  const instagram = [{ id: "a", handle: "brand-a", mine: true, signedIn: false, projectId: "p1" }, { id: "b", handle: "brand-b", mine: false, signedIn: false, projectId: "p2" }];
  expect(row(platformRows(view({ instagram }), "p1"), "instagram")?.own?.id).toBe("a");
  expect(row(platformRows(view({ instagram }), "p2"), "instagram")?.own?.id).toBe("b");
  expect(row(platformRows(view({ instagram, logins: { ...none, meta: true } }), "p3"), "instagram")).toMatchObject({ button: "Add" });
});

it("knows a sign-in finished elsewhere: an account connected by sign-in after the dialog opened, also one that was connected before", () => {
  const login = (handle: string, connectedAt: number): ConnectedAccount => ({ ...acct("youtube", handle), via: "login", connectedAt });
  const before = [login("tinyacrobatics", 100), { ...acct("tiktok", "tinytok"), connectedAt: 900 }];
  // the newest sign-in when the dialog opens: handles (by Apify) do not count
  expect(newestSignIn(before)).toBe(100);
  expect(newestSignIn([])).toBe(0);
  expect(signedInSince(before, 100)).toEqual([]);
  // a new account by sign-in, and the same account signed in again (its time moves)
  expect(signedInSince([...before, login("tinytwo", 250)], 100).map((a) => a.handle)).toEqual(["tinytwo"]);
  expect(signedInSince([login("tinyacrobatics", 300)], 100).map((a) => a.handle)).toEqual(["tinyacrobatics"]);
  // an account added by @handle meanwhile is the dialog's own doing, not a sign-in
  expect(signedInSince([...before, { ...acct("x", "tinyx"), connectedAt: 999 }], 100)).toEqual([]);
});

it("All workspaces lists every account the person has, and Add only for a platform with none", () => {
  const accounts = [acct("tiktok", "brand-a", "p1"), acct("tiktok", "brand-b", "p2"), acct("youtube", "old"), { ...acct("instagram", "tinyacrobatics", "p1"), analyzerId: "a1" }];
  // the Analyzer account a sign-in account fills is that account's row, not a second one
  const instagram = [{ id: "a1", handle: "tinyacrobatics", mine: true, signedIn: false, projectId: "p1" }, { id: "a2", handle: "tinyshop", mine: false, signedIn: false, projectId: "p2" }];
  const rows = everyRow(view({ accounts, instagram, logins: { meta: true, google: true, tiktok: true } }));
  expect(rows.map((r) => [r.platform, r.account?.handle ?? r.own?.handle ?? r.button])).toEqual([
    ["instagram", "tinyacrobatics"],
    ["instagram", "tinyshop"],
    ["facebook", "Add"],
    ["youtube", "old"],
    ["tiktok", "brand-a"],
    ["tiktok", "brand-b"],
  ]);
});

describe("/settings/connectors?add=<platform> (the address of a platform's Add dialog)", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | undefined;
  let search = "";
  let asked: string[] = [];
  const Where = () => ((search = useLocation().search), null);

  async function follow(platform: string, o: Parameters<typeof view>[0] & { viaService?: ConnectorsView["viaService"] } = {}) {
    const saved = { ...view(o), viaService: o.viaService, extras: { sessions: [] } };
    asked = [];
    useAuth.setState({ required: true, me: { username: "sam", role: "admin", cloud: false, off: [] } });
    putCached("sam", "/api/connectors", saved);
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url) !== "/api/connectors" || init?.method) asked.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify(String(url) === "/api/connectors" ? saved : { on: true }), { status: 200 });
    });
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => {
      root!.render(<MemoryRouter initialEntries={[`/settings/connectors?add=${platform}`]}><ConnectorsSection /><Where /></MemoryRouter>);
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

  it("starts the platform's sign-in where this server has its own app for it, drops the parameter and asks no one", async () => {
    const go = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: go });
    await follow("youtube", { logins: { ...none, google: true } });
    expect(go).toHaveBeenCalledTimes(1);
    expect(String(go.mock.calls[0][0])).toContain("google");
    expect(search).toBe("");
    expect(asked).toEqual([]);
  });

  it("does nothing for a platform with no sign-in here", async () => {
    const go = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: go });
    await follow("tiktok");
    expect(go).not.toHaveBeenCalled();
    expect(search).toBe("");
  });

  it("never asks the sign-in service: a platform whose sign-in comes from there stays closed until the person presses Add", async () => {
    await follow("youtube", { logins: { ...none, google: true }, viaService: ["google"] });
    expect(dialog()).toBe("");
    expect(document.body.textContent).toContain("YouTube");
    expect(search).toBe("");
    expect(asked).toEqual([]);
  });

  it("opens nothing for a platform whose account is already there, or for a name that is no platform", async () => {
    await follow("tiktok", { accounts: [acct("tiktok", "tinyacrobatics")] });
    expect(dialog()).toBe("");
    expect(search).toBe("");
    act(() => root!.unmount());
    await follow("1");
    expect(dialog()).toBe("");
    expect(search).toBe("");
  });
});

describe("an account's workspace", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | undefined;
  let sent: Array<[string, unknown]> = [];
  const two = [
    { id: "p1", owner: "sam", name: "Tiny Acrobatics", accountId: "a1", createdAt: 1 },
    { id: "p2", owner: "sam", name: "Tiny Acrobatics shop", createdAt: 2 },
  ] as ReturnType<typeof useWorkspace.getState>["projects"];

  async function open(o: Parameters<typeof view>[0], projects = two) {
    const saved = { ...view(o), extras: { sessions: [] } };
    sent = [];
    useAuth.setState({ required: true, me: { username: "sam", role: "admin", cloud: false, off: [] } });
    useWorkspace.setState({ loaded: true, currentProjectId: "p1", projects, load: async () => {} });
    putCached("sam", "/api/connectors", saved);
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method) sent.push([`${init.method} ${url}`, JSON.parse(String(init.body ?? "null"))]);
      // the Apify key row reads its usage: no use yet
      const answers: Record<string, unknown> = { "/api/connectors": saved, "/api/usage/services": { lines: [], limits: [], budgets: [] } };
      return new Response(JSON.stringify(answers[String(url).split("?")[0]!] ?? {}), { status: 200 });
    });
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => {
      root!.render(<MemoryRouter initialEntries={["/settings/connectors"]}><ConnectorsSection /></MemoryRouter>);
      await new Promise((done) => setTimeout(done, 0));
    });
  }
  /** Opens the row menu of `handle` and gives its items' words. */
  const menu = (handle: string) => {
    act(() => {
      document.body.querySelector(`button[aria-label="@${handle} actions"]`)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
    });
    return [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
  };
  const press = async (item: HTMLElement) => {
    await act(async () => {
      item.click();
      await new Promise((done) => setTimeout(done, 0));
    });
  };

  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = "";
    clearLocalCache();
    useWorkspace.setState({ loaded: false, currentProjectId: null, projects: [] });
    vi.unstubAllGlobals();
  });

  it("every workspace's accounts are listed, each with its workspace, and the page never switches the window's workspace", async () => {
    await open({ accounts: [acct("tiktok", "brand-a", "p1"), acct("tiktok", "brand-b", "p2"), acct("youtube", "old")] });
    const text = document.body.textContent ?? "";
    expect(text).toContain("@brand-a");
    expect(text).toContain("@brand-b");
    expect(text).toContain("Tiny Acrobatics shop");
    expect(text).toContain("No workspace");
    expect(useWorkspace.getState().currentProjectId).toBe("p1");
  });

  it("Add without a sign-in takes the handle and reads the public page; with no sign-in here the dialog offers none", async () => {
    await open({});
    expect(document.body.querySelector('button[aria-label="Add X"]')).toBeNull(); // no sign-in for X: not offered
    await press(document.body.querySelector('button[aria-label="Add TikTok"]') as HTMLElement);
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Add TikTok");
    // the dialog opens on its main action (here the handle), never on an info mark, whose bubble would cover it
    expect(document.activeElement).toBe(dialog.querySelector("input"));
    expect(dialog.textContent).not.toContain("Sign in");
    expect(dialog.textContent).not.toContain("Apify"); // a key that works: no key row
    const input = dialog.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "@tinyx");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press(dialog.querySelector('button[type="submit"]') as HTMLElement);
    expect(sent).toEqual([["POST /api/connectors/handles", { platform: "tiktok", handle: "@tinyx", projectId: "p1" }]]);
  });

  // a refused key is stored (configured, not valid): hiding the row then left no way to change it from setup
  it.each([{ configured: false, valid: null }, { configured: true, valid: false }])("the Add dialog holds the Apify key row while no key works: %o", async (apify) => {
    await open({ apify });
    await press(document.body.querySelector('button[aria-label="Add TikTok"]') as HTMLElement);
    expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain("Apify");
  });

  it("the row menu moves an account to another workspace: an account is one workspace's or none's", async () => {
    await open({ accounts: [acct("tiktok", "brand-a", "p1")] });
    const items = menu("brand-a");
    expect(items.map((i) => i.textContent)).toEqual(["Read again", "Move to Tiny Acrobatics shop", "Disconnect"]);
    await press(items[1]!);
    expect(sent).toEqual([["PATCH /api/connectors/accounts/tiktok%3Abrand-a", { projectId: "p2" }]]);
    expect(useWorkspace.getState().currentProjectId).toBe("p1");
  });

  it("Disconnect says the account leaves every workspace", async () => {
    await open({ accounts: [acct("tiktok", "brand-a", "p1")] });
    // no dialog host in a test: the app's confirm falls back to the browser's, title and body in one text
    const asked = vi.fn(() => false);
    vi.stubGlobal("confirm", asked);
    await press(menu("brand-a").at(-1)!);
    expect(asked).toHaveBeenCalledWith("Disconnect @brand-a?\n\nThe account is removed from every workspace.");
    expect(sent).toEqual([]);
  });

  it("Instagram's own account moves to a workspace of the person's own that links none; with no workspace only the one marked Mine stays listed", async () => {
    await open({ instagram: [{ id: "a1", handle: "tinyacrobatics", mine: true, signedIn: false, projectId: "p1" }] });
    const items = menu("tinyacrobatics");
    expect(items.map((i) => i.textContent)).toEqual(["Move to Tiny Acrobatics shop", "Disconnect"]);
    await press(items[0]!);
    expect(sent).toEqual([
      ["PATCH /api/workshop/projects/p2", { accountId: "a1" }],
      ["PATCH /api/workshop/projects/p1", { accountId: null }],
    ]);
  });

  it("one workspace: an account in none can still be put in it", async () => {
    await open({ accounts: [acct("youtube", "old")] }, two.slice(0, 1));
    expect(menu("old").map((i) => i.textContent)).toEqual(["Read again", "Move to Tiny Acrobatics", "Disconnect"]);
  });
});
