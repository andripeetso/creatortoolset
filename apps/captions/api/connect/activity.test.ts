import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

// A linked computer tells the account's phones when something starts to wait on its person: signed with its own key,
// a title, one line and a path, nothing else. Each trigger below is the public app's own moment, not a plug-in's.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "connect-activity-"));
process.env.APP_SECRET = "local-sign-in-test-secret";

const { ACTIVITY_TYP, io, phoneNotifyApp, phonesNotified, publishActivity } = await import("./activity");
const { computerKey, verifyJws } = await import("./keys");
const { connectState, saveConnectState } = await import("./state");
const { needsAttention } = await import("../lib/attention");
const { notifyWorkshopOwner } = await import("../review");
const { runEnded } = await import("../editor/ended");
const { libraryDb } = await import("../library/db");
const { env } = await import("../lib/env");
const { createUser } = await import("../users");

const BROKER = "https://connect.test.example/";
let posts: { url: string; claims: Record<string, unknown> }[] = [];

io.fetch = async (url, init) => {
  const proof = JSON.parse(String(init.body)).proof as string;
  posts.push({ url, claims: verifyJws(proof, ACTIVITY_TYP, computerKey().publicKey) ?? {} });
  return new Response("{}", { status: 200 });
};

const link = (over: Record<string, unknown> = {}) =>
  saveConnectState({
    brokerUrl: BROKER, owner: "acct-1", localUser: "tiny", computerId: computerKey().id, name: "Mac", origin: "http://127.0.0.1:43128",
    hostname: "x.tunnels.test.example", tunnelToken: "t", relayKid: "k", relayPublicKey: "", usedJti: {}, ...over,
  });
const settle = () => new Promise((r) => setTimeout(r, 50));
const sent = () => posts.map((p) => p.claims.activity as Record<string, unknown>);

beforeEach(() => {
  posts = [];
  link();
});

describe("publishActivity", () => {
  it("signs the note with this computer's key, addressed to the connect service, short-lived", async () => {
    expect(await publishActivity("tiny", { kind: "review", title: "Morning\nroutine", headline: "Ready for review", path: "/editor/e0", workspace: "ws_1" })).toBe(true);
    const [p] = posts;
    expect(p.url).toBe(`https://connect.test.example/v1/computers/${computerKey().id}/activity`);
    expect(p.claims).toMatchObject({ iss: `ct-computer:${computerKey().id}`, aud: "https://connect.test.example" });
    expect((p.claims.exp as number) - (p.claims.iat as number)).toBeLessThanOrEqual(60);
    expect(p.claims.activity).toMatchObject({ serverId: computerKey().id, kind: "review", title: "Morning routine", headline: "Ready for review", path: "/editor/e0", workspace: "ws_1" });
    expect(Object.keys(p.claims.activity as object).sort()).toEqual(["at", "headline", "kind", "path", "serverId", "title", "workspace"]);
  });

  it("sends nothing when not linked, when switched off, or for someone other than the linked person", async () => {
    expect(await publishActivity("someone-else", { kind: "failed", title: "A", headline: "B", path: "/a1" })).toBe(false);
    link({ notifyPhones: false });
    expect(await publishActivity("tiny", { kind: "failed", title: "A", headline: "B", path: "/a2" })).toBe(false);
    saveConnectState(null);
    expect(await publishActivity("tiny", { kind: "failed", title: "A", headline: "B", path: "/a3" })).toBe(false);
    expect(posts).toEqual([]);
  });

  it("the same note twice within a minute goes once", async () => {
    const note = { kind: "failed" as const, title: "A", headline: "Twice", path: "/a4" };
    expect(await publishActivity("tiny", note)).toBe(true);
    expect(await publishActivity("tiny", note)).toBe(false);
    expect(posts).toHaveLength(1);
  });
});

describe("Send notifications to your phones", () => {
  const as = (user: Record<string, unknown> | null) => {
    const h = new Hono();
    h.use(async (c, next) => {
      if (user) c.set("user" as never, user as never);
      return next();
    });
    h.route("/api/connect", phoneNotifyApp);
    return (method: string, body?: unknown) =>
      h.request("http://localhost/api/connect/notifications", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  };

  it("is on by default once linked; only the owner turns it off, and it comes back on with a new link", async () => {
    createUser("tiny", "a-long-test-password", { role: "admin" });
    const owner = as({ username: "tiny", role: "admin" });
    expect(await (await owner("GET")).json()).toEqual({ linked: true, on: true });
    expect((await as({ username: "tiny", role: "member" })("POST", { on: false })).status).toBe(403);
    expect((await as(null)("POST", { on: false })).status).toBe(403);
    expect((await owner("POST", { on: "no" })).status).toBe(400);
    expect(await (await owner("POST", { on: false })).json()).toEqual({ linked: true, on: false });
    expect(connectState()?.notifyPhones).toBe(false);
    expect(phonesNotified()).toBe(false);
    saveConnectState(null);
    link();
    expect(phonesNotified()).toBe(true);
  });
});

describe("triggers", () => {
  it("the assistant asks something, or its reply failed: its words stay in the chat", async () => {
    const base = { username: "tiny", chat: "c1", title: "my private first message", path: "/?chat=c1", sentAt: 0 };
    needsAttention({ ...base, reply: "r1", kind: "asks", body: "Needs approval · delete 4 clips from the shoot" });
    needsAttention({ ...base, reply: "r2", kind: "asks", body: "Which take do you like, the one where I trip?" });
    needsAttention({ ...base, reply: "r3", kind: "failed", body: "the reply text so far" });
    needsAttention({ ...base, reply: "r4", kind: "done", body: "All done!" });
    await settle();
    expect(sent().map((a) => [a.kind, a.title, a.headline, a.path])).toEqual([
      ["asks", "Assistant", "Needs your approval", "/?chat=c1"],
      ["asks", "Assistant", "Asks you something", "/?chat=c1"],
      ["failed", "Assistant", "A reply didn't finish", "/?chat=c1"],
    ]);
    expect(JSON.stringify(posts)).not.toMatch(/private|trip|delete 4|so far/);
  });

  it("an inbox note that waits on the owner: a job failed, an edit waits, a final came in", async () => {
    await notifyWorkshopOwner("tiny", { kind: "failed", by: "Automations", name: "Weekly recap", text: "Out of credit", href: "/settings/keys", ref: "x1", workspace: "ws_2" });
    await notifyWorkshopOwner("tiny", { kind: "waiting", by: "Editor", name: "Gym day", text: "Still waiting for the Media Library: 2 of 5 files", href: "/editor/e2", ref: "e2" });
    await notifyWorkshopOwner("tiny", { kind: "delivered", by: "Sam", name: "Launch reel", href: "/workshop/sessions/s1", ref: "s1" });
    await notifyWorkshopOwner("tiny", { kind: "workshop", by: "Content Workshop", name: "Ideas", text: "Done: Ideas", href: "/workshop", ref: "w" });
    await settle();
    expect(sent().map((a) => [a.kind, a.title, a.headline, a.path, a.workspace])).toEqual([
      ["failed", "Weekly recap", "Out of credit", "/settings/keys", "ws_2"],
      ["go", "Gym day", "Still waiting for the Media Library: 2 of 5 files", "/editor/e2", undefined],
      ["final", "Launch reel", "Sam delivered", "/workshop/sessions/s1", undefined],
    ]);
  });

  it("an AI Editor run ends with its cut in Review, or failed", async () => {
    const edit = (state: string, error?: string) => {
      const id = randomUUID();
      const dir = path.join(env.dataDir, "editor", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "edit.json"), JSON.stringify({ id, name: "Gym day", workspaceId: "lib_1", projectId: "ws_3", createdBy: "tiny", createdAt: 1, updatedAt: 1, sources: [] }));
      writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ lines: [], plans: [{ name: "v1" }], notes: [] }));
      const r = libraryDb()
        .prepare("INSERT INTO edit_jobs (library_id, version_id, kind, state, error) VALUES ('lib_1', ?, 'file', ?, ?)")
        .run(`${id}:v1`, state, error ?? null);
      runEnded({ id: Number(r.lastInsertRowid), version_id: `${id}:v1` } as never);
      return id;
    };
    const ok = edit("done");
    const bad = edit("failed", "The render\nstopped");
    await settle();
    expect(sent().map((a) => [a.kind, a.title, a.headline, a.path, a.workspace])).toEqual([
      ["review", "Gym day", "Ready for review", `/editor/${ok}`, "ws_3"],
      ["failed", "Gym day", "Did not finish: The render stopped", `/editor/${bad}`, "ws_3"],
    ]);
  });
});
