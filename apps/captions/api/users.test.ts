import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

// The browser is for viewing (AGENTS.md): an account signed in to in a plain browser reads and changes nothing, an
// admin's too, while the same sign-in in the Mac app's window works as before.

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "view-only-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "view-only-test-secret";

const { createUser, mayChange, plainBrowser } = await import("./users");
const { default: app, VIEW_ONLY_WRITES } = await import("./boot");

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0";
const PHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";
// the system web view: the Mac app's window and the iPhone app's pages
const MAC_APP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const PHONE_APP = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

let cookie = "";
beforeAll(async () => {
  createUser("owner", "password1", { role: "admin" });
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": CHROME },
    body: JSON.stringify({ username: "owner", password: "password1" }),
  });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  // the page is told at the sign-in itself, not only at its next check
  expect(((await res.json()) as { user: { viewOnly?: boolean } }).user.viewOnly).toBe(true);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const call = (agent: string, method: string, url: string) =>
  app.request(url, { method, headers: { cookie, "user-agent": agent, "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
const me = async (agent: string) => ((await (await call(agent, "GET", "/api/auth/check")).json()) as { user: { viewOnly?: boolean } }).user;

it("tells a plain browser from the apps' own web view", () => {
  for (const ua of [CHROME, SAFARI, FIREFOX, PHONE_SAFARI]) expect(plainBrowser(ua)).toBe(true);
  for (const ua of [MAC_APP, PHONE_APP, "Creator%20Toolset/3826 CFNetwork/3860 Darwin/25.6.0", "node", undefined]) expect(plainBrowser(ua)).toBe(false);
});

it("lets no account change a tool in view-only, an admin's included", () => {
  expect(mayChange({ role: "admin", off: [], read: [] }, "editor")).toBe(true);
  expect(mayChange({ role: "admin", off: [], read: [], viewOnly: true }, "editor")).toBe(false);
});

it("tells the page it is view-only in a plain browser and not in the Mac app's window", async () => {
  expect((await me(CHROME)).viewOnly).toBe(true);
  expect((await me(MAC_APP)).viewOnly).toBeUndefined();
});

it("reads in a plain browser and refuses every tool's change and a message to the assistant", async () => {
  expect((await call(CHROME, "GET", "/api/editor")).status).not.toBe(403);
  for (const url of ["/api/editor", "/api/workshop/sessions", "/api/library/x", "/api/review/x", "/api/assistant/chats"]) {
    const res = await call(CHROME, "POST", url);
    expect([url, res.status]).toEqual([url, 403]);
    expect(await res.json()).toMatchObject({ code: "READ_ONLY" });
  }
});

it("refuses what is not a tool's either: scheduled tasks, keys, packs, a workspace", async () => {
  for (const url of ["/api/automations", "/api/my-keys", "/api/packs/x", "/api/workspace/x", "/api/memory"]) {
    const res = await call(CHROME, "POST", url);
    expect([url, res.status]).toEqual([url, 403]);
    expect(await res.json()).toMatchObject({ code: "READ_ONLY" });
  }
});

it("lets a plain browser do what a reviewer does on a cut, and nothing else in Review", async () => {
  for (const path of ["/api/auth/logout", "/api/account/login/google", "/api/review/assets/a1/comments", "/api/review/assets/a1/comments/c1", "/api/review/assets/a1/approval", "/api/review/assets/a1/v/2/refs", "/api/review/notifications/read"])
    expect([path, VIEW_ONLY_WRITES.test(path)]).toEqual([path, true]);
  for (const path of ["/api/review/assets/a1", "/api/review/assets/a1/stack", "/api/review/assets/a1/comments/c1/x", "/api/review/uploads", "/api/authx", "/api/accounts", "/api/library/x"])
    expect([path, VIEW_ONLY_WRITES.test(path)]).toEqual([path, false]);
  // the gate itself: a comment gets to its route (which has no such cut), a rename does not
  const comment = await call(CHROME, "POST", "/api/review/assets/a1/comments");
  expect(comment.status === 403 ? await comment.json() : {}).not.toMatchObject({ code: "READ_ONLY" });
  expect(await (await call(CHROME, "PATCH", "/api/review/assets/a1")).json()).toMatchObject({ code: "READ_ONLY" });
});

it("takes the same changes from the Mac app's window", async () => {
  for (const url of ["/api/editor", "/api/assistant/chats"]) {
    const res = await call(MAC_APP, "POST", url);
    // whatever the route says of an empty body, the gate let it through
    expect(res.status === 403 ? await res.json() : {}).not.toMatchObject({ code: "READ_ONLY" });
  }
});

it("signs out of a plain browser", async () => {
  expect((await call(CHROME, "POST", "/api/auth/logout")).status).toBe(200);
});
