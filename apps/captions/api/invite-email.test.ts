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
  expect(failed.status).toBe(500);
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

it("access set on a pending invite is what the person gets once they join", async () => {
  const cookie = await login();
  const { findUser } = await import("./users");
  const { invite, token } = (await (await call("POST", "/api/workspace/invites", cookie, {})).json()) as { invite: { id: string }; token: string };
  const set = await call("PATCH", `/api/workspace/invites/${invite.id}`, cookie, { off: ["design", 42], scripts: true });
  expect(set.status).toBe(200);
  const shown = ((await set.json()) as { invites: { id: string; off: string[]; scripts: boolean }[] }).invites.find((i) => i.id === invite.id);
  expect(shown).toMatchObject({ off: ["design"], scripts: true });
  expect((await call("PATCH", `/api/workspace/invites/${invite.id}`, cookie, { scripts: "yes" })).status).toBe(400);
  expect((await call("PATCH", "/api/workspace/invites/nope", cookie, { scripts: true })).status).toBe(404);

  expect((await call("POST", `/api/auth/invite/${token}`, undefined, { name: "Bo", username: "bo", password: "bo-secret-12" })).status).toBe(200);
  expect(findUser("bo")?.off).toEqual(["design"]);
  const view = (await (await call("GET", "/api/workspace", cookie)).json()) as { members: { username: string; scripts?: boolean }[] };
  expect(view.members.find((m) => m.username === "bo")?.scripts).toBe(true);
});

it("the email and the join page name the workspaces the invite gives and the server, else the server alone", async () => {
  const cookie = await login();
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = path.join(process.env.DATA_DIR!, "workshop", "projects");
  mkdirSync(dir, { recursive: true });
  const id = "bbbbbbbb-0000-4000-8000-0000000000aa";
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, owner: env.adminUsername, name: "Tiny Acrobatics", createdAt: 1, updatedAt: 1 }));
  process.env.RESEND_API_KEY = "re_test";
  process.env.MAIL_FROM = "Creator Toolset <invites@example.com>";
  const sent: { subject: string; text: string }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => (sent.push(JSON.parse(String(init.body))), Response.json({ id: "1" })));
  const { token } = (await (await call("POST", "/api/workspace/invites", cookie, { email: "cy@example.com", workspaces: [id] })).json()) as { token: string };
  expect(sent[0]!.subject).toContain("to Tiny Acrobatics on Creator Toolset");
  expect(sent[0]!.text).toContain("work in Tiny Acrobatics on tools.example.com");
  expect(await (await call("GET", `/api/auth/invite/${token}`)).json()).toMatchObject({ workspace: "Team", target: "Tiny Acrobatics", server: "tools.example.com" });
  await call("POST", "/api/workspace/invites", cookie, { email: "di@example.com" });
  expect(sent[1]!.text).toContain("work in tools.example.com.");
});
