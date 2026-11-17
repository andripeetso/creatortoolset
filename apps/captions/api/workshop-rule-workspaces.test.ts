import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Rules and frameworks per workspace (lib/workshop/rule-workspaces.ts): All workspaces or Only these, a workspace's own
// version of a shared one, what the writer reads in each workspace, and a deleted workspace leaving every list. Model mocked.
const dataDir = mkdtempSync(path.join(tmpdir(), "ws-rule-workspaces-"));
process.env.DATA_DIR = dataDir;

vi.mock("./ai-complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai-complete")>()),
  streamWithFallback: vi.fn(),
}));

const { Hono } = await import("hono");
const { workshopApp } = await import("./workshop");
const { inRequestWorkspace } = await import("./lib/workspace-scope");
const { streamWithFallback } = await import("./ai-complete");
const mocked = vi.mocked(streamWithFallback);
const { createUser } = await import("./users");
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
createUser("alex", "password1", { role: "admin" });
const mac = pairDevice("alex", "Alex's Mac").device;
await saveSettings({
  instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.id }],
  default: { instance: "claude", model: "claude-opus-5-5", effort: "xhigh" },
  jobs: {},
});

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "alex", role: "admin", cloud: true, off: [] });
  await next();
});
app.use("*", inRequestWorkspace);
app.route("/api/workshop", workshopApp as never);
/** A request from a window in `workspace`. */
const call = (method: string, url: string, workspace: string, body?: unknown) =>
  app.request(`/api/workshop${url}`, { method, headers: { "Content-Type": "application/json", "X-CT-Workspace": workspace }, ...(body ? { body: JSON.stringify(body) } : {}) });
const read = async <T,>(r: Response | Promise<Response>) => (await (await r).json()) as T;

let seq = 0;
const uuid = () => `eeeeeeee-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const ws = (...p: string[]) => path.join(dataDir, "workshop", ...p);
function project(name: string, owner = "alex") {
  const id = uuid();
  mkdirSync(ws("projects"), { recursive: true });
  writeFileSync(ws("projects", `${id}.json`), JSON.stringify({ id, owner, name, audience: "", voice: "", cta: "", notes: "", createdAt: seq, updatedAt: seq }));
  return id;
}
function session(projectId: string, frameworkIds: string[] = []) {
  const id = uuid();
  const docId = uuid();
  mkdirSync(ws("sessions", id, "docs"), { recursive: true });
  writeFileSync(ws("sessions", id, "meta.json"), JSON.stringify({ id, owner: "alex", title: "Reel", query: "", sources: [], drafts: [], projectId, createdAt: 1, updatedAt: 1 }));
  writeFileSync(
    ws("sessions", id, "docs", `${docId}.json`),
    JSON.stringify({ id: docId, sessionId: id, kind: "reel", title: "Reel", frameworkIds, versions: [], nextBlock: 2, nextVersion: 1, createdAt: 1, updatedAt: 1, blocks: [{ id: "b1", text: "A reel", author: "ai", at: 1 }] }),
  );
  writeFileSync(ws("sessions", id, "chat.json"), JSON.stringify({ messages: [] }));
  return { id, docId };
}
/** One chat turn on a piece; returns the system prompt the writer was given. */
async function systemOf(workspace: string, s: { id: string; docId: string }): Promise<string> {
  let system: string | undefined;
  mocked.mockImplementationOnce((async (sys: string, _u: string, _sig: unknown, parse: (t: string) => unknown) => {
    system = sys;
    return { result: parse(JSON.stringify({ reply: "ok" })), provider: "Claude (Mac)" };
  }) as never);
  const r = await read<{ reply: { id: string } }>(call("POST", `/sessions/${s.id}/chat`, workspace, { docId: s.docId, text: "Go." }));
  for (let i = 0; i < 500 && !system; i++) {
    const chat = await read<Array<{ id: string; status?: string }>>(call("GET", `/sessions/${s.id}/chat`, workspace));
    if (chat.find((m) => m.id === r.reply.id)?.status !== "thinking") break;
    await new Promise((res) => setTimeout(res, 10));
  }
  expect(system).toBeDefined();
  return system!;
}

type Item = { id: string; name: string; text?: string; only?: string[]; changedHere?: boolean; versions?: unknown };
const tiny = project("Tiny Acrobatics");
const garden = project("Tiny Gardens");
const others = project("Someone else's", "nico");
const rules = (w: string) => read<Item[]>(call("GET", "/rules", w));
const frameworks = (w: string) => read<Item[]>(call("GET", "/frameworks", w));
const STEPS = "Open on the problem\nShow the fix";

describe("all workspaces or only these", () => {
  it("a rule or framework kept to some workspaces is listed only there; one for all workspaces everywhere", async () => {
    const shared = await read<Item>(call("POST", "/rules", tiny, { text: "Short sentences only" }));
    const kept = await read<Item>(call("POST", "/rules", tiny, { text: "Lead with the crawl", workspaces: { only: [tiny] } }));
    expect(kept.only).toEqual([tiny]);
    expect((await rules(tiny)).map((r) => r.id)).toEqual(expect.arrayContaining([shared.id, kept.id]));
    expect((await rules(garden)).map((r) => r.id)).toContain(shared.id);
    expect((await rules(garden)).map((r) => r.id)).not.toContain(kept.id);

    expect((await call("PATCH", `/rules/${kept.id}`, tiny, { workspaces: { only: [tiny, garden] } })).status).toBe(200);
    expect((await rules(garden)).map((r) => r.id)).toContain(kept.id);
    expect((await call("PATCH", `/rules/${kept.id}`, tiny, { workspaces: { all: true } })).status).toBe(200);
    expect((await rules(garden)).find((r) => r.id === kept.id)!.only).toBeUndefined();
    // none ticked, or a workspace that is not the person's (another account's)
    expect(await read(call("PATCH", `/rules/${kept.id}`, tiny, { workspaces: { only: [] } }))).toEqual({ error: "Pick a workspace" });
    expect((await call("PATCH", `/rules/${kept.id}`, tiny, { workspaces: { only: [others] } })).status).toBe(400);
    expect((await call("POST", "/rules", tiny, { text: "Never this", workspaces: { only: [others] } })).status).toBe(400);

    const fw = await read<Item>(call("POST", "/frameworks", garden, { name: "Garden walk", steps: STEPS, workspaces: { only: [garden] } }));
    expect((await frameworks(garden)).map((f) => f.id)).toContain(fw.id);
    expect((await frameworks(tiny)).map((f) => f.id)).not.toContain(fw.id);
  });
});

describe("changed for one workspace", () => {
  it("that workspace gets its own version under the same id; the others keep the shared one; deleting it brings the shared one back", async () => {
    const r = await read<Item>(call("POST", "/rules", tiny, { name: "Hook", text: "Open on a question" }));
    const mine = await read<Item>(call("PATCH", `/rules/${r.id}`, garden, { text: "Open on a garden question", here: true }));
    expect(mine).toMatchObject({ id: r.id, text: "Open on a garden question", changedHere: true });
    const inGarden = (await rules(garden)).find((x) => x.id === r.id)!;
    expect(inGarden).toMatchObject({ text: "Open on a garden question", changedHere: true });
    expect(inGarden.versions).toBeUndefined();
    expect((await rules(tiny)).find((x) => x.id === r.id)).toMatchObject({ text: "Open on a question" });
    expect((await rules(tiny)).find((x) => x.id === r.id)!.changedHere).toBeUndefined();

    // an edit in the garden changes its own version; one in the other workspace changes the shared one
    await call("PATCH", `/rules/${r.id}`, garden, { text: "Open on a seed question" });
    await call("PATCH", `/rules/${r.id}`, tiny, { text: "Open on a sharp question" });
    expect((await rules(garden)).find((x) => x.id === r.id)!.text).toBe("Open on a seed question");
    expect((await rules(tiny)).find((x) => x.id === r.id)!.text).toBe("Open on a sharp question");

    expect((await call("DELETE", `/rules/${r.id}/here`, garden)).status).toBe(200);
    expect((await rules(garden)).find((x) => x.id === r.id)).toMatchObject({ text: "Open on a sharp question" });
    expect((await call("DELETE", `/rules/${r.id}/here`, garden)).status).toBe(404);
    // one not used in this workspace has no version to make there
    const only = await read<Item>(call("POST", "/rules", tiny, { text: "Tiny only rule", workspaces: { only: [tiny] } }));
    expect(await read(call("PATCH", `/rules/${only.id}`, garden, { text: "Garden take", here: true }))).toEqual({ error: "Not used in this workspace" });

    const fw = await read<Item>(call("POST", "/frameworks", tiny, { name: "Before and after", steps: STEPS }));
    expect(await read(call("PATCH", `/frameworks/${fw.id}`, garden, { name: "Before and after, garden", here: true }))).toMatchObject({ id: fw.id, name: "Before and after, garden", changedHere: true });
    expect((await frameworks(tiny)).find((f) => f.id === fw.id)!.name).toBe("Before and after");
    expect((await call("DELETE", `/frameworks/${fw.id}/here`, garden)).status).toBe(200);
    expect((await frameworks(garden)).find((f) => f.id === fw.id)!.name).toBe("Before and after");
  });
});

describe("the writer reads what applies in the piece's workspace", () => {
  it("a framework's version, a rule kept to another workspace, and a rule switched off there", async () => {
    const fw = await read<Item>(call("POST", "/frameworks", tiny, { name: "Problem first", steps: STEPS }));
    await call("PATCH", `/frameworks/${fw.id}`, garden, { name: "Problem first, garden", here: true });
    const named = async (w: string) => {
      const s = session(w, [fw.id]);
      return (await read<{ frameworks?: Array<{ name: string }> }>(call("POST", `/sessions/${s.id}/docs/${s.docId}/material`, w, {}))).frameworks?.map((f) => f.name);
    };
    expect(await named(tiny)).toEqual(["Problem first"]);
    expect(await named(garden)).toEqual(["Problem first, garden"]);
    // kept to the garden: not read in a tiny piece, even when the piece names it
    await call("PATCH", `/frameworks/${fw.id}`, tiny, { workspaces: { only: [garden] } });
    expect(await named(tiny)).toBeUndefined();

    await call("POST", "/rules", tiny, { text: "Always name the crawl stage", workspaces: { only: [tiny] } });
    const changed = await read<Item>(call("POST", "/rules", tiny, { text: "End on the next step" }));
    await call("PATCH", `/rules/${changed.id}`, garden, { text: "End on what to plant next", here: true });
    const inTiny = await systemOf(tiny, session(tiny));
    expect(inTiny).toContain("Always name the crawl stage");
    expect(inTiny).toContain("End on the next step");
    const inGarden = await systemOf(garden, session(garden));
    expect(inGarden).not.toContain("Always name the crawl stage");
    expect(inGarden).toContain("End on what to plant next");
    expect(inGarden).not.toContain("End on the next step");
    // the workspace's off list names the shared id, and switches off its version too
    expect((await call("PATCH", `/projects/${garden}`, garden, { name: "Tiny Gardens", off: [changed.id] })).status).toBe(200);
    expect(await systemOf(garden, session(garden))).not.toContain("plant next");
  });
});

describe("deleting a workspace", () => {
  it("drops it from every list: a rule kept only to it is deleted, one kept to it and another stays for the other, its versions go", async () => {
    const gone = project("Tiny Pottery");
    const onlyGone = await read<Item>(call("POST", "/rules", gone, { text: "Pottery only", workspaces: { only: [gone] } }));
    const both = await read<Item>(call("POST", "/frameworks", gone, { name: "Pottery and tiny", steps: STEPS, workspaces: { only: [gone, tiny] } }));
    const shared = await read<Item>(call("POST", "/rules", gone, { text: "Shared rule" }));
    await call("PATCH", `/rules/${shared.id}`, gone, { text: "Pottery's take", here: true });

    expect((await call("DELETE", `/projects/${gone}`, tiny)).status).toBe(200);
    expect(existsSync(ws("rules", `${onlyGone.id}.json`))).toBe(false);
    expect(JSON.parse(readFileSync(ws("frameworks", `${both.id}.json`), "utf-8")).only).toEqual([tiny]);
    expect(JSON.parse(readFileSync(ws("rules", `${shared.id}.json`), "utf-8")).versions).toBeUndefined();
    expect((await rules(tiny)).find((r) => r.id === shared.id)!.text).toBe("Shared rule");
  });
});
