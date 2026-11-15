import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Settings → Team's "Send invite": the link emailed through Resend (api/lib/mail.ts), only on a server with its keys.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "invite-email-"));
process.env.APP_SECRET = "invite-email-secret";
process.env.CT_MODE = "hosted";
delete process.env.RESEND_API_KEY;
delete process.env.MAIL_FROM;

const { default: app } = await import("./boot");
const { env } = await import("./lib/env");

const call = (method: string, url: string, cookie?: string, body?: unknown) =>
  Promise.resolve(
    app.request(`https://tools.example.com${url}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const login = async () =>
  ((await call("POST", "/api/auth/login", undefined, { username: env.adminUsername, password: env.appSecret })).headers.get("set-cookie") ?? "").split(";")[0];
const invites = async (cookie: string) => ((await (await call("GET", "/api/workspace", cookie)).json()) as { invites: { email?: string }[]; mail?: boolean });

afterEach(() => vi.unstubAllGlobals());

it("emails the invite link only when the server has Resend's keys, and keeps no link it failed to send", async () => {
  const cookie = await login();
  expect((await invites(cookie)).mail).toBe(false);
  expect((await call("POST", "/api/workspace/invites", cookie, { email: "ann@example.com" })).status).toBe(400);

  process.env.RESEND_API_KEY = "re_test";
  process.env.MAIL_FROM = "Creator Toolset <invites@example.com>";
  const sent: { to: string[]; text: string; from: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.resend.com/emails");
    sent.push(JSON.parse(String(init.body)));
    return Response.json({ id: "1" });
  });
  expect((await call("POST", "/api/workspace/invites", cookie, { email: "not an email" })).status).toBe(400);
  const made = await call("POST", "/api/workspace/invites", cookie, { email: " Ann@Example.com " });
  expect(made.status).toBe(200);
  const { token } = (await made.json()) as { token: string };
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toEqual(["ann@example.com"]);
  expect(sent[0].text).toContain(`https://tools.example.com/join/${token}`);
  expect((await invites(cookie)).invites.map((i) => i.email)).toEqual(["ann@example.com"]);

  vi.stubGlobal("fetch", async () => Response.json({ message: "domain not verified" }, { status: 403 }));
  const failed = await call("POST", "/api/workspace/invites", cookie, { email: "bo@example.com" });
  expect(failed.status).toBe(502);
  expect(((await failed.json()) as { error: string }).error).toContain("domain not verified");
  expect((await invites(cookie)).invites).toHaveLength(1);
});

it("the join page names the inviter by their name, and the new account keeps the name it was given", async () => {
  const cookie = await login();
  const { findUser, setDisplayName } = await import("./users");
  setDisplayName(findUser(env.adminUsername)!, "Andri");
  vi.stubGlobal("fetch", async () => Response.json({ id: "1" }));
  const { token } = (await (await call("POST", "/api/workspace/invites", cookie, {})).json()) as { token: string };
  expect(((await (await call("GET", `/api/auth/invite/${token}`)).json()) as { invitedBy: string }).invitedBy).toBe("Andri");
  expect((await call("POST", `/api/auth/invite/${token}`, undefined, { name: " Ann Lee ", username: "ann", password: "ann-secret-123" })).status).toBe(200);
  expect(findUser("ann")?.displayName).toBe("Ann Lee");
});
