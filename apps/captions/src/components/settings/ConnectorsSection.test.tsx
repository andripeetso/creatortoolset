// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/lib/auth";
import { clearLocalCache, putCached } from "@/lib/local-cache";
import { ConnectorsSection, newestSignIn, platformRows, signedInSince, signInItems } from "./ConnectorsSection";
import type { ConnectedAccount, ConnectorsView } from "@contracts/connectors";

it("offers only the sign-ins this server has an app for", () => {
  expect(signInItems({ meta: false, google: true, tiktok: false })).toEqual([{ id: "google", label: "Sign in with YouTube" }]);
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

it("the platform list: one row per platform, in order, with the one button each row does", () => {
  // the owner's server: no sign-in app, an Apify key, his own Instagram in the Analyzer
  const rows = platformRows(view({ instagram: [{ id: "a1", handle: "tinyacrobatics", followers: 4120, mine: true }] }));
  expect(rows.map((r) => r.platform)).toEqual(["instagram", "facebook", "youtube", "tiktok", "x"]);
  expect(row(rows, "instagram")).toMatchObject({ summary: "@tinyacrobatics · 4,120 followers", own: { id: "a1" } });
  expect(row(rows, "instagram")?.button).toBeUndefined();
  expect(row(rows, "youtube")).toMatchObject({ button: "Add", summary: "Public channels, by @handle" });
  // disconnected: Instagram adds the person's own account by @handle
  expect(row(platformRows(view({})), "instagram")).toMatchObject({ button: "Add", summary: "Your account, by @handle" });
});

it("a row never asks for the Apify key: with none, every platform still has just Add (the dialog sends the person to API keys)", () => {
  const rows = platformRows(view({ apify: { configured: false, valid: null }, logins: { ...none, google: true } }));
  expect(row(rows, "youtube")).toMatchObject({ button: "Add", summary: "Your channel by sign-in, or by @handle" });
  expect(row(rows, "x")).toMatchObject({ button: "Add", summary: "Public accounts, by @handle" });
  expect(row(platformRows(view({ apify: { configured: true, valid: false } })), "tiktok")).toMatchObject({ button: "Add" });
  for (const r of rows) expect(JSON.stringify(r)).not.toMatch(/apify|key/i);
});

it("Instagram adds its own account when the Meta sign-in is set", () => {
  expect(row(platformRows(view({ logins: { ...none, meta: true } })), "instagram")).toMatchObject({ button: "Add", summary: "Your account by sign-in, or by @handle" });
});

it("a platform whose sign-in the service does not offer says so on its row, and still has Add (by @handle)", () => {
  const all = { meta: true, google: true, tiktok: true };
  expect(row(platformRows(view({ logins: all })), "tiktok")).toMatchObject({ button: "Add", summary: "Your account by sign-in, or by @handle" });
  const rows = platformRows(view({ logins: all }), undefined, ["tiktok"]);
  expect(row(rows, "tiktok")).toMatchObject({ button: "Add", summary: "Sign-in is not available right now. Public accounts, by @handle" });
  // the other platforms are as they were
  expect(row(rows, "youtube")).toMatchObject({ summary: "Your channel by sign-in, or by @handle" });
});

it("each project shows its own account per platform; an account in no project shows until one is linked", () => {
  const accounts = [acct("tiktok", "brand-a", "p1"), acct("tiktok", "brand-b", "p2"), acct("youtube", "old")];
  const p1 = platformRows(view({ accounts }), "p1");
  expect(row(p1, "tiktok")).toMatchObject({ summary: "@brand-a · 4,120 followers" });
  expect(row(p1, "tiktok")?.button).toBeUndefined();
  expect(row(platformRows(view({ accounts }), "p2"), "tiktok")?.account?.handle).toBe("brand-b");
  expect(row(p1, "youtube")?.account?.handle).toBe("old");
  // a project with nothing on X gets the Add button
  expect(row(p1, "x")).toMatchObject({ button: "Add" });
  expect(row(p1, "x")?.account).toBeUndefined();
});

it("Instagram follows the project: the account a project links, else the one marked Mine that no project links", () => {
  const instagram = [{ id: "a", handle: "brand-a", mine: true, projectId: "p1" }, { id: "b", handle: "brand-b", mine: false, projectId: "p2" }];
  expect(row(platformRows(view({ instagram }), "p1"), "instagram")?.own?.id).toBe("a");
  expect(row(platformRows(view({ instagram }), "p2"), "instagram")?.own?.id).toBe("b");
  expect(row(platformRows(view({ instagram }), "p3"), "instagram")).toMatchObject({ button: "Add" });
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

  it("opens the platform's Add dialog on its handle field, drops the parameter and adds nothing by itself", async () => {
    await follow("tiktok");
    expect(dialog()).toContain("Add a TikTok account");
    expect(search).toBe("");
    expect(asked).toEqual([]);
  });

  it("offers the sign-in too where this server has its own app for it, without asking anyone", async () => {
    await follow("youtube", { logins: { ...none, google: true } });
    expect(dialog()).toContain("Add a YouTube account");
    expect(dialog()).toContain("My own account: sign in with YouTube");
    expect(asked).toEqual([]);
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
