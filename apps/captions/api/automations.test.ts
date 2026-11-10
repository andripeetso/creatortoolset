import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Automation } from "../contracts/automations";
import type { Route } from "./lib/providers";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "automations-"));
process.env.APP_SECRET = "automations-test-secret";

// the Mac's AI: each call answers with a numbered line and the prompt it got is kept, so a test reads what the AI saw
const prompts: string[] = [];
vi.mock("./lib/mac-claude", async (orig) => ({
  ...(await orig<typeof import("./lib/mac-claude")>()),
  streamMacClaude: vi.fn(async (_system: string, prompt: string) => {
    prompts.push(prompt);
    return `Answer ${prompts.length}`;
  }),
}));

const { createUser, newApiKey } = await import("./users");
const app = (await import("./boot")).default;
const { tick, blockOf, runAutomation, MISSED_MS } = await import("./automations");
const { mintJobToken } = await import("./auth");

const alice = createUser("alice", "password1");
const bob = createUser("bobby", "password1");
const dave = createUser("dave1", "password1");
const keys: Record<string, string> = { alice: `Bearer ${newApiKey(alice, "full")}`, bob: `Bearer ${newApiKey(bob, "full")}`, dave: `Bearer ${newApiKey(dave, "full")}` };

type Who = "alice" | "bob";
/** A request as the account (its Full key, or another authorization); `p` is the path under /api. */
const req = (who: Who | { auth: string }, method: string, p: string, body?: unknown) =>
  app.request(`/api${p}`, {
    method,
    headers: { authorization: typeof who === "string" ? keys[who]! : who.auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads of free-form JSON
type Json = Record<string, any>;
const json = async (r: Response) => (await r.json()) as Json;
const list = async (who: Who) => (await json(await req(who, "GET", "/automations"))).items as Json[];
const find = async (who: Who, id: string) => (await list(who)).find((x) => x.id === id);
const chats = async (who: Who) => json(await req(who, "GET", "/assistant"));

const daily = { kind: "fixed", at: "09:00" };
const everyHour = { kind: "interval", everyMinutes: 60 };

async function make(who: Who, body: Record<string, unknown>) {
  const r = await req(who, "POST", "/automations", body);
  expect(r.status).toBe(201);
  return json(r);
}

/** A route as readiness would give it: Claude Code on an online computer. */
const ready = { route: { scope: "alice", selection: { instance: "claude", model: "claude-opus-5-5", effort: "high" }, instance: { id: "claude", driver: "claude", name: "Claude Code", enabled: true, device: "mac" }, device: "mac" } as unknown as Route, url: "http://test/api/mcp" };

describe("scheduled tasks: REST, per account", () => {
  it("creates in the account's own list, and the other account sees none of it", async () => {
    const a = await make("alice", { name: "Monday hooks", schedule: daily, prompt: "Draft three hooks", timezone: "Europe/Berlin" });
    expect(a).toMatchObject({ timezone: "Europe/Berlin", enabled: true, destination: "new_chat" });
    expect((await list("alice")).map((x) => x.id)).toContain(a.id);
    expect(await list("bob")).toEqual([]);
  });

  it("one account can't see, change, run or delete another's task", async () => {
    const a = await make("alice", { name: "Mine", schedule: everyHour, prompt: "Count the posts" });
    expect((await req("bob", "PATCH", `/automations/${a.id}`, { name: "Stolen" })).status).toBe(404);
    expect((await req("bob", "DELETE", `/automations/${a.id}`)).status).toBe(404);
    expect((await req("bob", "POST", `/automations/${a.id}/run`)).status).toBe(404);
    expect((await find("alice", a.id))?.name).toBe("Mine");
  });

  it("refuses bad input at the boundary", async () => {
    const post = (body: Record<string, unknown>) => req("alice", "POST", "/automations", body);
    expect((await post({ name: "x", schedule: daily, prompt: "p" })).status).toBe(400); // a time of day without a zone
    expect((await post({ name: "x", schedule: { kind: "fixed", at: "25:00" }, prompt: "p", timezone: "UTC" })).status).toBe(400);
    expect((await post({ name: "x", schedule: daily, prompt: "p", timezone: "Mars/Base" })).status).toBe(400);
    expect((await post({ name: "", schedule: everyHour, prompt: "p" })).status).toBe(400);
    expect((await post({ name: "x", schedule: everyHour, prompt: "x".repeat(4001) })).status).toBe(400);
    expect((await post({ name: "x", schedule: everyHour, prompt: "p", destination: "email" })).status).toBe(400);
    expect((await post({ name: "x", schedule: everyHour, prompt: "p", ai: { instance: "c", model: "m", effort: "huge" } })).status).toBe(400);
    const past = await post({ name: "x", schedule: { kind: "once", runAt: Date.now() - 60_000 }, prompt: "p" });
    expect(past.status).toBe(400);
    expect((await json(past)).error).toContain("The run time has passed");
    expect((await make("alice", { schedule: everyHour, prompt: "Summarise the week" })).name).toBe("Summarise the week"); // the name defaults to the prompt
  });

  it("a once task's next run is its time; a fresh fixed-time task's is in the future", async () => {
    const when = Date.now() + 2 * 3_600_000;
    expect((await make("alice", { name: "Once", schedule: { kind: "once", runAt: new Date(when).toISOString() }, prompt: "p" })).nextRun).toBe(when);
    expect((await make("alice", { name: "Morning", schedule: daily, prompt: "p", timezone: "Europe/Berlin" })).nextRun).toBeGreaterThan(Date.now());
  });

  it("turning it back on counts from now, so it doesn't fire for the time it was off", async () => {
    const a = await make("alice", { name: "Paused", schedule: everyHour, prompt: "p" });
    await req("alice", "PATCH", `/automations/${a.id}`, { enabled: false });
    const on = await json(await req("alice", "PATCH", `/automations/${a.id}`, { enabled: true }));
    expect(on.lastRun).toBeGreaterThan(Date.now() - 60_000);
    expect(on.nextRun).toBeGreaterThan(Date.now());
  });

  it("keeps the AI it is given, and switching to a new chat each run forgets its chat", async () => {
    const ai = { instance: "claude", model: "claude-opus-5-5", effort: "max" };
    const a = await make("alice", { name: "Mine", schedule: everyHour, prompt: "p", ai, destination: "continue" });
    expect(a.ai).toEqual(ai);
    const p = await json(await req("alice", "PATCH", `/automations/${a.id}`, { destination: "new_chat" }));
    expect(p.chat).toBeUndefined();
  });

  it("a once task that has run can still be renamed, but not set to run again in the past", async () => {
    const a = await make("alice", { name: "Once", schedule: { kind: "once", runAt: Date.now() + 60_000 }, prompt: "p" });
    const file = path.join(process.env.DATA_DIR!, "automations", "alice.json");
    const all = JSON.parse(readFileSync(file, "utf8")) as Automation[];
    Object.assign(all.find((x) => x.id === a.id)!, { schedule: { kind: "once", runAt: Date.now() - 60_000 }, lastRun: Date.now() - 50_000 });
    writeFileSync(file, JSON.stringify(all));
    expect((await req("alice", "PATCH", `/automations/${a.id}`, { name: "Renamed" })).status).toBe(200);
    expect((await req("alice", "PATCH", `/automations/${a.id}`, { enabled: true })).status).toBe(400);
  });

  it("deletes its own, and only once", async () => {
    const gone = await make("alice", { name: "Gone", schedule: everyHour, prompt: "p" });
    expect((await req("alice", "DELETE", `/automations/${gone.id}`)).status).toBe(200);
    expect((await req("alice", "DELETE", `/automations/${gone.id}`)).status).toBe(404);
  });
});

describe("the scheduler", () => {
  const hold = new Promise<void>(() => {}); // never settles: a run stays in progress
  const always = () => ready;

  it("a due task starts once per instant, and a running one is not started again", async () => {
    const a = await make("alice", { name: "Due once", schedule: everyHour, prompt: "p" });
    const later = Date.now() + 5 * 3_600_000;
    const started: string[] = [];
    const runner = async (_u: string, x: Automation) => {
      started.push(x.id);
      await hold;
    };
    void tick(later, runner, always);
    await tick(later, runner, always);
    expect(started.filter((id) => id === a.id)).toHaveLength(1);
    expect((await req("alice", "POST", `/automations/${a.id}/run`)).status).toBe(409);
  });

  it("a disabled task is never started", async () => {
    const a = await make("alice", { name: "Off", schedule: everyHour, prompt: "p", enabled: false });
    const started: string[] = [];
    await tick(Date.now() + 9 * 3_600_000, async (_u, x) => void started.push(x.id), always);
    expect(started).not.toContain(a.id);
  });

  it("a task whose computer is offline waits and runs when it is back; a fixed time that late is skipped instead", async () => {
    const interval = await make("bob", { name: "Waits", schedule: everyHour, prompt: "p" });
    const later = Date.now() + 2 * 3_600_000;
    const started: string[] = [];
    const run = async (_u: string, x: Automation) => void started.push(x.id);
    await tick(later, run, () => ({ wait: "Mac Studio is offline" }));
    expect((await find("bob", interval.id))?.lastResult).toBeUndefined(); // still due, nothing recorded
    await tick(later + 3 * 3_600_000, run, always);
    expect(started).toContain(interval.id);

    const fixed = await make("bob", { name: "Morning", schedule: { kind: "fixed", at: "09:00" }, prompt: "p", timezone: "UTC" });
    const due = (await find("bob", fixed.id))!.nextRun as number;
    await tick(due + MISSED_MS + 60_000, run, () => ({ wait: "Mac Studio is offline" }));
    const after = await find("bob", fixed.id);
    expect(after?.lastResult).toMatchObject({ status: "skipped", text: "Missed the 09:00 run (Mac Studio is offline)." });
    expect(after?.nextRun).toBeGreaterThan(due + MISSED_MS);
    expect(started).not.toContain(fixed.id);
  });

  it("one a person has to fix is skipped with the reason, in the task and once in the inbox", async () => {
    const a = await make("bob", { name: "Inbox me", schedule: { kind: "interval", everyMinutes: 1 }, prompt: "p" });
    const t0 = Date.now() + 3_600_000;
    await tick(t0); // the real readiness: bob has no AI
    await tick(t0 + 120_000);
    expect((await find("bob", a.id))?.lastResult).toMatchObject({ status: "skipped", text: expect.stringContaining("No Claude Code is set up for your AI here") });
    const notes = ((await json(await req("bob", "GET", "/review/notifications"))).items as Array<{ name: string }>).filter((n) => n.name === "Inbox me");
    expect(notes).toHaveLength(1);
  });

  it("says why no task can run: an admin is sent to Providers, a team member is told the team's AI can't", async () => {
    expect((await json(await req("bob", "GET", "/automations"))).blocked).toContain("No Claude Code is set up for your AI here");
    expect(blockOf(null, true)).toContain("Add it on a computer in Providers");
    expect(blockOf(null, false)).toContain("Your team's AI can't run them");
  });
});

describe("runs land in assistant chats", () => {
  const stored = async (id: string) => (await find("alice", id)) as Automation;

  it("new chat each run: a new chat named after the task holds the prompt and the answer; the open chat is left alone", async () => {
    const a = await make("alice", { name: "Hook ideas", schedule: everyHour, prompt: "Write three hooks" });
    const open = (await chats("alice")).id;
    await runAutomation("alice", await stored(a.id), ready);
    await runAutomation("alice", await stored(a.id), ready);
    const view = await chats("alice");
    expect(view.id).toBe(open);
    const made = view.past.filter((p: Json) => p.title === "Hook ideas");
    expect(made).toHaveLength(2);
    const last = await stored(a.id);
    expect(last.lastResult).toMatchObject({ status: "done", chat: made[0].id });
    expect(last.chat).toBeUndefined();
    // open it as the dock would: the prompt is the user's message, marked with its task, and the answer is under it
    const opened = await json(await req("alice", "POST", `/assistant/past/${made[0].id}/open`));
    expect(opened.id).toBe(made[0].id);
    expect(opened.messages.map((m: Json) => [m.role, m.text])).toEqual([
      ["user", "Write three hooks"],
      ["assistant", expect.stringMatching(/^Answer \d+$/)],
    ]);
    expect(opened.messages[0].task).toEqual({ id: a.id, name: "Hook ideas" });
    // the chat keeps its id after it is put away again, so a link to it still opens it
    expect((await json(await req("alice", "DELETE", "/assistant"))).past.some((p: Json) => p.id === made[0].id)).toBe(true);
  });

  it("one chat, continuing: the second run posts in the first run's chat and the AI sees the first run", async () => {
    const a = await make("alice", { name: "Daily notes", schedule: everyHour, prompt: "Note what changed", destination: "continue" });
    await runAutomation("alice", await stored(a.id), ready);
    const chat = (await stored(a.id)).chat!;
    expect(chat).toBeTruthy();
    await runAutomation("alice", await stored(a.id), ready);
    expect((await stored(a.id)).lastResult?.chat).toBe(chat);
    const first = prompts.at(-2)!;
    expect(prompts.at(-1)).toContain(first.match(/Answer \d+/)?.[0] ?? "Note what changed");
    expect(prompts.at(-1)).toContain('This is a run of the scheduled task "Daily notes"');
  });

  it("one chat, fresh each run: same chat, but the AI sees only this run's prompt", async () => {
    const a = await make("alice", { name: "Fresh", schedule: everyHour, prompt: "Count the drafts", destination: "fresh" });
    await runAutomation("alice", await stored(a.id), ready);
    const chat = (await stored(a.id)).chat;
    await runAutomation("alice", await stored(a.id), ready);
    expect((await stored(a.id)).lastResult?.chat).toBe(chat);
    expect(prompts.at(-1)).not.toMatch(/Assistant: Answer/);
  });

  it("made from an assistant chat (its job token), a task posts its runs in that chat", async () => {
    const view = await chats("alice");
    const someChat = view.past[0];
    const opened = await json(await req("alice", "POST", `/assistant/past/${someChat.id}/open`));
    const reply = opened.messages.at(-1).id;
    // the assistant's own path: its job token on /api/mcp, the schedule_task tool, the routes it calls
    const token = `Bearer ${mintJobToken("alice", reply)}`;
    const r = await app.request("/api/mcp", {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "schedule_task", arguments: { name: "From the chat", schedule: everyHour, prompt: "p" } } }),
    });
    const out = (await r.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(out.result.isError).toBeUndefined();
    const made = JSON.parse(out.result.content[0]!.text) as Json;
    expect(made).toMatchObject({ destination: "continue", next_run: expect.any(String) });
    expect((await stored(made.id)).chat).toBe(someChat.id);
  });

  it("task chats never push the person's own chats out of the history", async () => {
    const dir = path.join(process.env.DATA_DIR!, "assistant");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "dave1.json"), JSON.stringify({ messages: [], past: [{ id: "mine", messages: [{ id: "m1", role: "user", text: "my own chat", at: 1 }] }] }));
    const { runInChat, PAST_KEPT } = await import("./assistant");
    for (let i = 0; i < PAST_KEPT + 3; i++)
      await runInChat("dave1", { task: { id: "t", name: "Spam" }, prompt: "p", preface: "", fresh: true, route: ready.route, url: ready.url });
    const view = await json(await req({ auth: keys.dave! }, "GET", "/assistant"));
    expect(view.past).toHaveLength(PAST_KEPT);
    expect(view.past.some((p: Json) => p.id === "mine")).toBe(true);
  });
});
