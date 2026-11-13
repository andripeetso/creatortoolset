import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A reply a usage limit stopped: the chat says when the limit resets and carries on by itself then.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "assistant-limit-"));
process.env.APP_SECRET = "assistant-test-secret";

const { createUser } = await import("./users");
const app = (await import("./boot")).default;
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
const { writeWorkPrefs } = await import("./work-prefs");
const { DEFAULT_SETTINGS } = await import("../contracts/providers");
const { CONTINUE, resumeFromDisk } = await import("./assistant");
type View = import("../contracts/assistant").AssistantView;
type Chat = import("../contracts/assistant").AssistantChat;

const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** What the relay said in the owner's chat on 2026-11-13, with the cooldown shortened. */
const gateway = (after: string) =>
  `Claude: API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling down (last error: rate_limit_error: This request would exceed your account's rate limit. Please try again later.) (reset after ${after})`;

async function person(name: string) {
  createUser(name, "password1");
  const mac = pairDevice(name, `${name}'s Mac`);
  await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, name);
  const login = await app.request("/api/auth/login", { method: "POST", ...json({ username: name, password: "password1" }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const device = { authorization: `Bearer ${mac.token}` };
  return {
    claim: async () => (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, device) })).json()) as { id: string; user: string },
    fail: (id: string, body: Record<string, unknown>) => app.request(`/api/devices/relay/${id}/fail`, { method: "POST", ...json(body, device) }),
    answer: (id: string, text: string) => app.request(`/api/devices/relay/${id}/done`, { method: "POST", ...json({ text }, device) }),
    view: async () => (await (await app.request("/api/assistant", { headers: { cookie } })).json()) as View,
    chats: async () => ((await (await app.request("/api/assistant/chats", { headers: { cookie } })).json()) as { chats: Chat[] }).chats,
    send: (text: string) => app.request("/api/assistant/turn", { method: "POST", ...json({ text }, { cookie }) }),
    limit: (chat: string, resume: boolean) => app.request(`/api/assistant/chats/${chat}/limit`, { method: "POST", ...json({ resume }, { cookie }) }),
    snooze: (chat: string, until: number | null) => app.request(`/api/assistant/chats/${chat}/snooze`, { method: "POST", ...json({ until }, { cookie }) }),
  };
}

/** The view once its newest reply has ended. */
async function ended(p: Awaited<ReturnType<typeof person>>) {
  let v = await p.view();
  for (let i = 0; i < 100 && v.messages.at(-1)?.status === "thinking"; i++) v = (await tick(), await p.view());
  return v;
}

/** A message whose reply the relay turns away with `error`. */
async function limited(p: Awaited<ReturnType<typeof person>>, error: string, extra: Record<string, unknown> = {}) {
  const job = p.claim();
  await p.send("How should a launch post look?");
  await p.fail((await job).id, { error, ...extra });
  return ended(p);
}

const stillWaiting = async (p: Promise<unknown>, ms = 150) => (await Promise.race([p.then(() => "settled"), tick(ms).then(() => "waiting")])) === "waiting";

describe("a reply a usage limit stopped", () => {
  it("says when it resets, carries on by itself then, once, and is no longer Limited", async () => {
    const p = await person("ula");
    const before = Date.now();
    const v = await limited(p, gateway("1s"));
    const last = v.messages.at(-1)!;
    expect(last).toMatchObject({ status: "error", limit: { resume: true } });
    expect(last.limit!.until).toBeGreaterThanOrEqual(before + 1000);
    expect(last.limit!.until).toBeLessThan(Date.now() + 1100);
    expect((await p.chats())[0]).toMatchObject({ limited: true });
    // the reset comes: the chat says it by itself, and the AI hears the whole chat
    const again = await p.claim();
    expect(again.user).toContain("How should a launch post look?");
    expect(again.user).toContain(CONTINUE);
    await p.answer(again.id, "Here's the post.");
    const after = await ended(p);
    expect(after.messages.slice(-2)).toMatchObject([{ role: "user", text: CONTINUE }, { role: "assistant", status: "done", text: "Here's the post." }]);
    expect((await p.chats())[0]!.limited).toBeUndefined();
    // and only once
    expect(await stillWaiting(p.claim(), 1500)).toBe(true);
  });

  it("Cancel auto-resume: nothing happens at the reset; Resume at reset after it carries on at once", async () => {
    const p = await person("uma");
    const v = await limited(p, gateway("1s"));
    expect((await p.limit(v.id, false)).status).toBe(200);
    expect((await p.view()).messages.at(-1)!.limit).toEqual({ until: v.messages.at(-1)!.limit!.until });
    const job = p.claim();
    expect(await stillWaiting(job, 1500)).toBe(true);
    await p.limit(v.id, true);
    expect((await job).user).toContain(CONTINUE);
  });

  it("Snooze until reset puts the chat away till then; it comes back working", async () => {
    const p = await person("una");
    const v = await limited(p, gateway("1s"));
    const until = v.messages.at(-1)!.limit!.until!;
    await p.snooze(v.id, until);
    expect((await p.view()).snoozed).toBe(until);
    expect((await p.chats())[0]).toMatchObject({ snoozed: until, limited: true });
    const again = await p.claim();
    expect(again.user).toContain(CONTINUE);
    expect((await p.view()).snoozed).toBeUndefined();
  });

  it("keeps waiting across a restart of the server", async () => {
    const p = await person("uri");
    await limited(p, gateway("1s"));
    expect(readFileSync(path.join(process.env.DATA_DIR!, "assistant", "uri.json"), "utf-8")).toContain('"resume":{"');
    resumeFromDisk();
    expect((await p.claim()).user).toContain(CONTINUE);
  });

  it("with auto-resume off in Settings it waits for Resume at reset; snooze on puts the chat away by itself", async () => {
    const p = await person("ulf");
    writeWorkPrefs("ulf", { autoResume: false, snoozeLimited: true });
    const v = await limited(p, gateway("1h"));
    const last = v.messages.at(-1)!;
    expect(last.limit).toEqual({ until: expect.any(Number) });
    expect(v.snoozed).toBe(last.limit!.until);
  });

  it("a limit that doesn't say when it resets: no time, nothing to arm", async () => {
    const p = await person("uwe");
    const v = await limited(p, "Claude: You've hit your limit", { limit: true });
    expect(v.messages.at(-1)).toMatchObject({ status: "error", limit: {} });
    expect((await p.limit(v.id, true)).status).toBe(404);
  });

  it("an ordinary failure is not a limit", async () => {
    const p = await person("uta");
    const v = await limited(p, "Claude: something broke");
    expect(v.messages.at(-1)!.limit).toBeUndefined();
    expect((await p.chats())[0]!.limited).toBeUndefined();
  });

  it("anything said in the chat meanwhile ends the wait", async () => {
    const p = await person("ute");
    await limited(p, gateway("1s"));
    const job = p.claim();
    await p.send("Never mind");
    const got = await job;
    expect(got.user).toContain("Never mind");
    expect(got.user).not.toContain(CONTINUE);
    await p.answer(got.id, "OK.");
    await ended(p);
    expect(await stillWaiting(p.claim(), 1500)).toBe(true);
  });
});
