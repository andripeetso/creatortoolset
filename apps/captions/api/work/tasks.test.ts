import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WORK_V, type TaskPackage } from "../../contracts/work";

/**
 * Computer tasks: with the server's video work off a task waits with its line until a computer of the asker claims it;
 * the computer's run sends its file and the kind's apply files it on the server; This Mac runs it at once.
 */

const root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-tasks-"));
mkdirSync(path.join(root, "data"));
process.env.DATA_DIR = path.join(root, "data");
process.env.APP_SECRET = "work-tasks-test-secret";
vi.mock("../plugins.gen", () => ({ serverPlugins: [] }));

const app = (await import("../boot")).default;
const { pairDevice } = await import("../lib/devices");
const { CLAIM_POLL } = await import("./routes");
const { client } = await import("./computer");
const { workWaits } = await import("./place");
const { writeServerWork } = await import("./server-work");
const { runTaskJob, startTask, taskFor, taskKind, taskTick } = await import("./tasks");
CLAIM_POLL.holdMs = 0;
afterAll(() => rmSync(root, { recursive: true, force: true }));

const source = path.join(root, "in.txt");
writeFileSync(source, "tiny acrobatics");
const applied: { ref: string; text: string; where: string }[] = [];
const failed: string[] = [];
taskKind<{ word: string }, { where: string }>("test-upper", {
  serve: (_t, name) => (name === "source" ? source : undefined),
  async run(input, ctx) {
    const text = readFileSync(await ctx.file("source"), "utf8");
    await writeFile(path.join(ctx.dir, "out.txt"), `${input.word} ${text.toUpperCase()}`);
    ctx.beat("Making it loud");
    return { result: { where: ctx.where }, files: ["out.txt"] };
  },
  apply: (t, r, files) => void applied.push({ ref: t.ref, text: readFileSync(files["out.txt"]!, "utf8"), where: r.where }),
  failed: (t, e) => void failed.push(`${t.ref}: ${e}`),
});

const pc = pairDevice("tiny", "Tiny Mac");
const o = { server: "http://server.test", token: pc.token, beatMs: 20, fetch: (u: string, i?: RequestInit) => Promise.resolve(app.request(u, i)) };
const c = client(o);
const claim = async (tasks: string[]) => (await c.post<{ task?: TaskPackage }>("work/claim", { v: WORK_V, steps: [], tasks })).task;

describe("computer tasks", () => {
  it("waits with the line while no computer is online and the server's video work is off", async () => {
    writeServerWork({ on: false });
    const got = await startTask("test-upper", "a", "tiny", null, { word: "hi" });
    expect(got).toMatchObject({ state: "queued", line: expect.stringMatching(/^Waits for one of your computers/) });
    await taskTick();
    expect(applied).toEqual([]);
    expect(taskFor("test-upper", "a")?.state).toBe("queued");
  });

  it("a computer that runs the kind claims it, runs it and the server files its result", async () => {
    // an older worker names no kinds: never handed one
    expect(await claim([])).toBeUndefined();
    const t = await claim(["test-upper"]);
    expect(t).toMatchObject({ task: { kind: "test-upper", actor: "tiny" }, input: { word: "hi" } });
    expect(await runTaskJob(t!, c, o)).toBe("done");
    expect(applied).toEqual([{ ref: "a", text: "hi TINY ACROBATICS", where: "computer" }]);
    expect(taskFor("test-upper", "a")?.state).toBe("done");
  });

  it("a computer that names the kind is woken for a queued one", async () => {
    await startTask("test-upper", "b", "tiny", null, { word: "yo" });
    const { deviceOf } = await import("../lib/devices");
    expect(await workWaits(deviceOf(pc.device.id)!)).toBe(true);
    const t = await claim(["test-upper"]);
    // a claim answered for someone else's computer, or after the task was taken back, is refused
    const other = pairDevice("someone", "Other Mac");
    const res = await app.request(`/api/devices/relay/work/task/${t!.task.id}/done`, {
      method: "POST",
      headers: { authorization: `Bearer ${other.token}`, "x-ct-claim": t!.task.claim, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(410);
    expect(await runTaskJob(t!, c, o)).toBe("done");
  });

  it("with the server's video work on and no computer online the server runs it itself", async () => {
    writeServerWork({ on: true });
    const { setDeviceWork } = await import("../lib/devices");
    setDeviceWork(pc.device.id, { v: WORK_V, steps: [] }); // the computer no longer runs tasks
    const got = await startTask<{ word: string }, { where: string }>("test-upper", "c", "tiny", null, { word: "ok" });
    expect(got).toEqual({ state: "done", result: { where: "server" } });
    expect(applied.at(-1)).toEqual({ ref: "c", text: "ok TINY ACROBATICS", where: "server" });
    writeServerWork({ on: false });
  });

  it("This Mac runs it at once: the server is the person's own computer", async () => {
    process.env.CT_LOCAL = "1";
    try {
      expect((await startTask("test-upper", "d", "tiny", null, { word: "mac" })).state).toBe("done");
    } finally {
      delete process.env.CT_LOCAL;
    }
    expect(failed).toEqual([]);
  });
});
