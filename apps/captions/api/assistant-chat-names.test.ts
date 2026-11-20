import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "chat-names-"));
process.env.APP_SECRET = "chat-names-test-secret";
process.env.CHAT_NAMES = "1";

const { createUser } = await import("./users");
const app = (await import("./boot")).default;
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
const { DEFAULT_SETTINGS } = await import("../contracts/providers");

createUser("ana", "password1");
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");

const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const macAuth = { authorization: `Bearer ${mac.token}` };
const cookie = await (async () => {
  const r = await app.request("/api/auth/login", { method: "POST", ...json({ username: "ana", password: "password1" }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
})();

type Job = { id: string; system: string; user: string };
/** The Mac's next two requests: the chat's name and the turn, in whichever order they come. */
const twoJobs = async () => {
  const jobs: Job[] = [];
  for (let i = 0; i < 2; i++) jobs.push((await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, macAuth) })).json()) as Job);
  const name = jobs.find((j) => j.user.startsWith("User message:"))!;
  return { name, turn: jobs.find((j) => j !== name)! };
};
const done = (id: string, text: string) => app.request(`/api/devices/relay/${id}/done`, { method: "POST", ...json({ text }, macAuth) });
const chats = async () => ((await (await app.request("/api/assistant/chats", { headers: { cookie } })).json()) as { chats: Array<{ id: string; title: string }> }).chats;

describe("a new chat's name", () => {
  it("is written by its AI from the first message and what came with it", async () => {
    await app.request("/api/assistant/turn", { method: "POST", ...json({ text: "edit the video", context: { path: "/workshop", title: "ApologyVideoButStandalone" } }, { cookie }) });
    const { name, turn } = await twoJobs();
    expect(name.user).toContain("edit the video");
    expect(name.user).toContain("Page: ApologyVideoButStandalone");
    expect((await chats())[0]!.title).toBe("edit the video");
    await done(name.id, '"Edit the apology video."');
    await done(turn.id, "On it.");
    expect((await chats())[0]!.title).toBe("Edit the apology video");
  });

  it("never replaces a name given by hand meanwhile, and a later message asks for none", async () => {
    const id = ((await (await app.request("/api/assistant/chats", { method: "POST", ...json({}, { cookie }) })).json()) as { id: string }).id;
    await app.request(`/api/assistant/chats/${id}/turn`, { method: "POST", ...json({ text: "make a reel about floor time" }, { cookie }) });
    const { name, turn } = await twoJobs();
    await app.request(`/api/assistant/chats/${id}/title`, { method: "POST", ...json({ title: "Mine" }, { cookie }) });
    await done(name.id, "Floor time reel");
    await done(turn.id, "Done.");
    expect((await chats()).find((c) => c.id === id)!.title).toBe("Mine");
    await app.request(`/api/assistant/chats/${id}/turn`, { method: "POST", ...json({ text: "shorter" }, { cookie }) });
    const next = (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, macAuth) })).json()) as Job;
    expect(next.user).not.toMatch(/^User message:/);
    await done(next.id, "Shorter.");
  });
});
