import { expect, it } from "vitest";
import { platformRows, signInItems } from "./ConnectorsSection";
import type { ConnectedAccount, ConnectorsView } from "@contracts/connectors";

it("offers only the sign-ins this server has an app for", () => {
  expect(signInItems({ meta: false, google: true, tiktok: false })).toEqual([{ id: "google", label: "Sign in with YouTube" }]);
  expect(signInItems({ meta: false, google: false, tiktok: false })).toEqual([]);
});

const none = { meta: false, google: false, tiktok: false };
const acct = (platform: ConnectedAccount["platform"], handle: string, projectId?: string): ConnectedAccount => ({ key: `${platform}:${handle}`, platform, platformId: handle, handle, via: "apify", connectedAt: 0, projectId, stats: { followers: 4120 } });
const view = (o: Partial<Pick<ConnectorsView, "logins" | "apify" | "accounts" | "mine">>) => ({ logins: none, apify: { configured: true, valid: true }, accounts: [], ...o });
const row = (rows: ReturnType<typeof platformRows>, id: string) => rows.find((r) => r.platform === id);

it("the platform list: one row per platform, in order, with the one button each row does", () => {
  // the owner's server: no sign-in app, an Apify key, his own Instagram in the Analyzer
  const rows = platformRows(view({ mine: "tinyacrobatics" }));
  expect(rows.map((r) => r.platform)).toEqual(["instagram", "facebook", "youtube", "tiktok", "x"]);
  expect(row(rows, "instagram")).toMatchObject({ summary: "@tinyacrobatics" });
  expect(row(rows, "instagram")?.button).toBeUndefined();
  expect(row(rows, "youtube")).toMatchObject({ button: "Add", needsKey: false, summary: "Public channels, by @handle" });
  // no Instagram of his own and no Meta sign-in: nothing to add here, so no row
  expect(row(platformRows(view({})), "instagram")).toBeUndefined();
});

it("without an Apify key the handle platforms say so and their button adds the key; a sign-in app keeps its platform working", () => {
  const rows = platformRows(view({ apify: { configured: false, valid: null }, logins: { ...none, google: true } }));
  expect(row(rows, "youtube")).toMatchObject({ button: "Add", needsKey: false, summary: "Your channel by sign-in, or by @handle" });
  expect(row(rows, "x")).toMatchObject({ button: "Add key", needsKey: true });
  expect(row(platformRows(view({ apify: { configured: true, valid: false } })), "tiktok")).toMatchObject({ button: "Add key", needsKey: true });
});

it("Instagram adds its own account when the Meta sign-in is set", () => {
  expect(row(platformRows(view({ logins: { ...none, meta: true } })), "instagram")).toMatchObject({ button: "Add", summary: "Your account by sign-in" });
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
