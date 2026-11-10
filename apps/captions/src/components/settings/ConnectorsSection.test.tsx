import { expect, it } from "vitest";
import { platformRows, signInItems } from "./ConnectorsSection";
import type { ConnectedAccount, ConnectorsView } from "@contracts/connectors";

it("offers only the sign-ins this server has an app for", () => {
  expect(signInItems({ meta: false, google: true, tiktok: false })).toEqual([{ id: "google", label: "Sign in with YouTube" }]);
  expect(signInItems({ meta: false, google: false, tiktok: false })).toEqual([]);
});

const none = { meta: false, google: false, tiktok: false };
const acct = (platform: ConnectedAccount["platform"], handle: string, projectId?: string): ConnectedAccount => ({ key: `${platform}:${handle}`, platform, platformId: handle, handle, via: "apify", connectedAt: 0, projectId, stats: { followers: 4120 } });
const view = (o: Partial<Pick<ConnectorsView, "logins" | "apify" | "accounts" | "instagram">>) => ({ logins: none, apify: { configured: true, valid: true }, accounts: [], instagram: [], ...o });
const row = (rows: ReturnType<typeof platformRows>, id: string) => rows.find((r) => r.platform === id);

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
