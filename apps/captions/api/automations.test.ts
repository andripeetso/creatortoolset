import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "automations-"));
process.env.APP_SECRET = "automations-test-secret";

const { createUser, newApiKey } = await import("./users");
const app = (await import("./boot")).default;
const { tick } = await import("./automations");

const alice = createUser("alice", "password1");
const bob = createUser("bobby", "password1");
const keys = { alice: `Bearer ${newApiKey(alice, "full")}`, bob: `Bearer ${newApiKey(bob, "full")}` };

type Who = keyof typeof keys;
/** A request as the account (its Full key); `p` is the full path under /api. */
const req = (who: Who, method: string, p: string, body?: unknown) =>
  app.request(`/api${p}`, {
    method,
    headers: { authorization: keys[who], "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const list = async (who: Who) => (await json(await req(who, "GET", "/automations"))).items as Array<Record<string, any>>;
const find = async (who: Who, id: string) => (await list(who)).find((x) => x.id === id);

const daily = { kind: "daily", at: "09:00" };
const everyHour = { kind: "hours", every: 1 };

async function make(who: Who, body: Record<string, unknown>) {
  const r = await req(who, "POST", "/automations", body);
  expect(r.status).toBe(201);
  return json(r);
}

describe("automations: REST, per account", () => {
  it("creates in the account's own list, and the other account sees none of it", async () => {
    const a = await make("alice", { name: "Monday hooks", schedule: daily, prompt: "Draft three hooks", timezone: "Europe/Berlin" });
    expect(a.timezone).toBe("Europe/Berlin");
    expect(a.enabled).toBe(true);
    expect((await list("alice")).map((x) => x.id)).toContain(a.id);
    expect(await list("bob")).toEqual([]);
  });

  it("one account can't see, change, run or delete another's automation", async () => {
    const a = await make("alice", { name: "Mine", schedule: everyHour, prompt: "Count the posts" });
    expect((await req("bob", "PATCH", `/automations/${a.id}`, { name: "Stolen" })).status).toBe(404);
    expect((await req("bob", "DELETE", `/automations/${a.id}`)).status).toBe(404);
    expect((await req("bob", "POST", `/automations/${a.id}/run`)).status).toBe(404);
    expect((await find("alice", a.id))?.name).toBe("Mine");
  });

  it("refuses bad input at the boundary", async () => {
    const post = (body: Record<string, unknown>) => req("alice", "POST", "/automations", body);
    expect((await post({ name: "x", schedule: daily, prompt: "p" })).status).toBe(400); // daily without a zone
    expect((await post({ name: "x", schedule: { kind: "daily", at: "25:00" }, prompt: "p", timezone: "UTC" })).status).toBe(400);
    expect((await post({ name: "x", schedule: daily, prompt: "p", timezone: "Mars/Base" })).status).toBe(400);
    expect((await post({ name: "", schedule: everyHour, prompt: "p" })).status).toBe(400);
    expect((await post({ name: "x", schedule: everyHour, prompt: "x".repeat(4001) })).status).toBe(400);
    const hourly = await make("alice", { name: "Hourly", schedule: everyHour, prompt: "p" });
    expect(hourly.timezone).toBe("UTC"); // an every-N-hours schedule doesn't need a zone
  });

  it("a fresh daily automation's next run is in the future", async () => {
    const a = await make("alice", { name: "Morning", schedule: daily, prompt: "p", timezone: "Europe/Berlin" });
    expect(a.nextRun).toBeGreaterThan(Date.now());
  });

  it("turning it back on counts from now, so it doesn't fire for the time it was off", async () => {
    const a = await make("alice", { name: "Paused", schedule: everyHour, prompt: "p" });
    await req("alice", "PATCH", `/automations/${a.id}`, { enabled: false });
    const on = await json(await req("alice", "PATCH", `/automations/${a.id}`, { enabled: true }));
    expect(on.lastRun).toBeGreaterThan(Date.now() - 60_000);
    expect(on.nextRun).toBeGreaterThan(Date.now());
  });

  it("deletes its own, and only once", async () => {
    const gone = await make("alice", { name: "Gone", schedule: everyHour, prompt: "p" });
    expect((await req("alice", "DELETE", `/automations/${gone.id}`)).status).toBe(200);
    expect((await req("alice", "DELETE", `/automations/${gone.id}`)).status).toBe(404);
    expect((await list("alice")).map((x) => x.id)).not.toContain(gone.id);
  });
});

describe("automations: runs and the scheduler", () => {
  it("run now with no AI yet is skipped: the reason lands in lastResult and in the owner's inbox", async () => {
    const a = await make("bob", { name: "Inbox me", schedule: everyHour, prompt: "p" });
    expect((await req("bob", "POST", `/automations/${a.id}/run`)).status).toBe(202);
    let result: { status: string; text: string } | undefined;
    for (let i = 0; i < 100 && !result; i++) {
      result = (await find("bob", a.id))?.lastResult;
      if (!result) await new Promise((r) => setTimeout(r, 20));
    }
    expect(result?.status).toBe("skipped");
    expect(result?.text).toContain("Connect your AI");
    // the result is saved before its inbox note is written, so wait for the note too
    let notes: Array<[string, string]> = [];
    for (let i = 0; i < 100 && !notes.length; i++) {
      notes = ((await json(await req("bob", "GET", "/review/notifications"))).items as Array<{ name: string; by: string }>).map((n) => [n.name, n.by]);
      if (!notes.length) await new Promise((r) => setTimeout(r, 20));
    }
    expect(notes).toContainEqual(["Inbox me", "Automations"]);
  });

  it("a run that is still going refuses a second start (409), and a tick doesn't start it again", async () => {
    const a = await make("alice", { name: "Busy", schedule: everyHour, prompt: "p" });
    const hold = new Promise<void>(() => {}); // never settles: the first run stays in progress
    const started: string[] = [];
    const runner = async (_u: string, x: { id: string }) => {
      started.push(x.id);
      await hold;
    };
    const later = Date.now() + 3 * 3_600_000;
    void tick(later, runner);
    await tick(later, runner);
    expect(started.filter((id) => id === a.id)).toHaveLength(1);
    expect((await req("alice", "POST", `/automations/${a.id}/run`)).status).toBe(409);
  });

  it("a due automation starts once per instant: a second tick at the same time does not start it again", async () => {
    const a = await make("alice", { name: "Due once", schedule: everyHour, prompt: "p" });
    const later = Date.now() + 5 * 3_600_000;
    const started: string[] = [];
    const hold = new Promise<void>(() => {});
    const runner = async (_u: string, x: { id: string }) => {
      started.push(x.id);
      await hold;
    };
    void tick(later, runner);
    await tick(later, runner);
    expect(started.filter((id) => id === a.id)).toHaveLength(1);
  });

  it("a disabled automation is never started by a tick", async () => {
    const a = await make("alice", { name: "Off", schedule: everyHour, prompt: "p", enabled: false });
    const started: string[] = [];
    await tick(Date.now() + 9 * 3_600_000, async (_u, x) => {
      started.push(x.id);
    });
    expect(started).not.toContain(a.id);
  });

  it("a missed slot runs once, and the next one is counted from that run", async () => {
    const a = await make("bob", { name: "Missed", schedule: everyHour, prompt: "p" });
    const late = Date.now() + 10 * 3_600_000;
    await tick(late); // the real runner: no AI on this account, so it is skipped with the reason
    const after = await find("bob", a.id);
    expect(after?.lastRun).toBe(late);
    expect(after?.lastResult.status).toBe("skipped");
    await tick(late); // the same instant again: not due any more
    expect((await find("bob", a.id))?.lastResult.at).toBe(after?.lastResult.at);
  });
});
