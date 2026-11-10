import { expect, it } from "vitest";
import { platformRows, signInItems } from "./ConnectorsSection";
import type { ConnectedAccount, ConnectorsView } from "@contracts/connectors";

it("offers only the sign-ins this server has an app for", () => {
  expect(signInItems({ meta: false, google: true, tiktok: false })).toEqual([{ id: "google", label: "Sign in with YouTube" }]);
  expect(signInItems({ meta: false, google: false, tiktok: false })).toEqual([]);
});

const none = { meta: false, google: false, tiktok: false };
const acct = (platform: ConnectedAccount["platform"]): ConnectedAccount => ({ key: `${platform}:x`, platform, platformId: "x", handle: "x", via: "apify", connectedAt: 0 });
const view = (o: Partial<Pick<ConnectorsView, "logins" | "apify" | "accounts">>) => ({ logins: none, apify: { configured: true, valid: true }, accounts: [], ...o });
const row = (rows: ReturnType<typeof platformRows>, id: string) => rows.find((r) => r.platform === id)!;

it("the platform list: one row per platform, in order, with the one button each row does", () => {
  // the owner's server as he sees it: no sign-in app, an Apify key: every handle platform adds by @handle, Instagram goes to the Analyzer
  const rows = platformRows(view({}));
  expect(rows.map((r) => r.platform)).toEqual(["instagram", "facebook", "youtube", "tiktok", "x"]);
  expect(row(rows, "instagram")).toMatchObject({ button: "Open Analyzer", needsKey: false });
  expect(row(rows, "youtube")).toMatchObject({ button: "Add", needsKey: false, summary: "Public channels, by @handle" });
  expect(row(rows, "x")).toMatchObject({ button: "Add", summary: "Public accounts, by @handle" });
});

it("without an Apify key the handle platforms say so and their button adds the key; a sign-in app keeps its platform working", () => {
  const rows = platformRows(view({ apify: { configured: false, valid: null }, logins: { ...none, google: true } }));
  // YouTube has its sign-in: Add still works, the handle option just needs the key inside the dialog
  expect(row(rows, "youtube")).toMatchObject({ button: "Add", needsKey: false, summary: "Your channel by sign-in, others by @handle" });
  // X has no sign-in: the key is the only way
  expect(row(rows, "x")).toMatchObject({ button: "Add key", needsKey: true });
  // an Apify key the platform refused is the same as none
  expect(platformRows(view({ apify: { configured: true, valid: false } })).find((r) => r.platform === "tiktok")).toMatchObject({ button: "Add key", needsKey: true });
});

it("Instagram adds its own account when the Meta sign-in is set; Facebook shares that sign-in", () => {
  const rows = platformRows(view({ logins: { ...none, meta: true } }));
  expect(row(rows, "instagram")).toMatchObject({ button: "Add", summary: "Your account by sign-in, others in the Content Analyzer" });
  expect(row(rows, "facebook")).toMatchObject({ button: "Add", summary: "Your Pages by sign-in, others by @handle" });
});

it("counts the connected accounts on each platform", () => {
  const rows = platformRows(view({ accounts: [acct("tiktok"), acct("tiktok"), acct("youtube")] }));
  expect(row(rows, "tiktok").connected).toBe(2);
  expect(row(rows, "youtube").connected).toBe(1);
  expect(row(rows, "x").connected).toBe(0);
});
