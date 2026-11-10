import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

// A server with sign-in (APP_SECRET): the Mac app finishes a social sign-in in the computer's browser, which has no
// session. The account is still saved for the person who started it, and that browser gets a page, not the login.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "connectors-cb-"));
process.env.APP_SECRET = "callback-test-secret";
process.env.META_APP_ID = "app";
process.env.META_APP_SECRET = "secret";

const { Hono } = await import("hono");
const { connectorsApp, connectorsCallbackApp } = await import("./connectors");
const { readConnectors } = await import("./lib/connectors/store");

const app = new Hono<{ Variables: { user: unknown } }>();
app.route("/api/connectors", connectorsCallbackApp as never);
app.use("*", async (c, next) => {
  c.set("user", { username: "ana", role: "user", cloud: true, off: [] });
  await next();
});
app.route("/api/connectors", connectorsApp as never);

it("saves the account for whoever started the sign-in and shows a page in a browser without their session", async () => {
  const state = new URL((await app.request("/api/connectors/login/meta")).headers.get("location")!).searchParams.get("state")!;
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/oauth/access_token")) return Response.json({ access_token: "long" });
    if (u.includes("/me/accounts")) return Response.json({ data: [{ id: "p1", name: "Tiny Acrobatics", access_token: "page-token" }] });
    return Response.json({ data: [] });
  });
  const res = await app.request(`/api/connectors/callback/meta?state=${state}&code=abc`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Connected");
  expect(readConnectors("ana").accounts.map((a) => a.key)).toEqual(["facebook:p1"]);
  // the same state again: refused, still a page
  expect((await app.request(`/api/connectors/callback/meta?state=${state}&code=abc`)).status).toBe(400);
  vi.unstubAllGlobals();
});
