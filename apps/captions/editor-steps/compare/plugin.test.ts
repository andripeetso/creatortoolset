// Compare through the real routes: the Workshop's own (Generate draft, the session's pieces) and the plug-in's, mounted as
// the app mounts them. Only the Mac relay is stood in: two AIs of one person on one paired Mac, Claude and Codex.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "compare-"));
process.env.DATA_DIR = dataDir;

type Call = { system: string; user: string; instance: string };
const relay = vi.hoisted(() => ({
  calls: [] as Call[],
  /** what each AI does, by instance id: a text to answer, or an error to throw */
  answer: {} as Record<string, () => Promise<string>>,
}));
vi.mock("../../api/lib/mac-claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/mac-claude")>()),
  streamMacClaude: vi.fn(async (system: string, user: string, _sig: unknown, _d: unknown, _usage: unknown, opts: { provider?: { instance: string } }) => {
    relay.calls.push({ system, user, instance: opts.provider!.instance });
    return relay.answer[opts.provider!.instance]!();
  }),
}));
vi.mock("../../api/lib/devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/devices")>()),
  isOnline: () => true,
}));

const { Hono } = await import("hono");
const { workshopApp } = await import("../../api/workshop");
const { createUser } = await import("../../api/users");
const { pairDevice } = await import("../../api/lib/devices");
const { saveSettings } = await import("../../api/lib/providers");
const { MacClaudeError } = await import("../../api/lib/mac-claude");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");
const { installPack } = await import("../../api/lib/packs");
const { default: plugin, PICKS_MAX, COMPARES_MAX } = await import("./plugin");

createUser("nico", "password1");
createUser("ola", "password1");
createUser("ada", "password1", { role: "admin" });
const mac = pairDevice("nico", "Nico's Mac").device;
await saveSettings(
  {
    ...structuredClone(DEFAULT_SETTINGS),
    instances: [
      { id: "claude_work", driver: "claude", name: "Claude (work)", enabled: true, device: mac.id },
      { id: "codex", driver: "codex", name: "Codex", enabled: true, device: mac.id },
      // an AI that runs with tools on the Mac: another person's pack text never goes to it
      { id: "agent", driver: "acp", name: "Agent", enabled: true, device: mac.id, model: "local", acp: { command: "agent", args: [] } },
    ],
    default: { instance: "claude_work", model: "opus", effort: "high" },
  },
  "nico",
);
const CLAUDE = { instance: "claude_work", model: "opus", effort: "high" };
const CODEX = { instance: "codex", model: "gpt-6-luna", effort: "high" };
// every word that would say which AI wrote what: names, drivers, tools, models, the Mac
const NAMES = /claude|codex|opus|luna|nico/i;

const as = (username: string, off: string[] = [], role = "member") => {
  const app = new Hono<{ Variables: { user: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("user", { username, role, cloud: true, off });
    await next();
  });
  app.route("/api/workshop", workshopApp as never);
  app.route("/api/x/compare", plugin.routes!);
  return (method: string, url: string, body?: unknown) =>
    app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
};
const call = as("nico");
const plan = (title: string, text: string) => async () => JSON.stringify({ title, markdown: text });

async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await get();
  for (let i = 0; i < 500 && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 10));
    v = await get();
  }
  return v;
}

let n = 0;
/** A made-up session of nico's, with a note the request carries. */
function session(): string {
  const id = `dddddddd-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const dir = path.join(dataDir, "workshop", "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, owner: "nico", title: "Stretching", query: "", sources: [], drafts: [], createdAt: 1, updatedAt: 1 }));
  writeFileSync(path.join(dir, "notes.md"), "Tiny Acrobatics: keep it short.");
  return id;
}

type View = { picked: string | null; sides: Array<{ label: string; status: string; markdown?: string; error?: string; ai?: { name: string; model: string } }> };
const seen: string[] = [];
/** GET the session's compare as text (kept, to check for names), until both sides are done. */
const finished = (id: string, who = call) =>
  until(
    async () => {
      const text = await (await who("GET", `/api/x/compare/sessions/${id}`)).text();
      seen.push(text);
      return JSON.parse(text).compare as View;
    },
    (v) => !!v && v.sides.every((s) => s.status !== "writing"),
  );
const start = async (id: string, extra: Record<string, unknown> = {}) => {
  const r = await call("POST", `/api/x/compare/sessions/${id}`, { a: CLAUDE, b: CODEX, kind: "free", prompt: "Three reasons to stretch", ...extra });
  const text = await r.text();
  seen.push(text);
  return { status: r.status, body: JSON.parse(text) as { compare?: View; error?: string } };
};
const sideOf = (v: View, title: string) => v.sides.find((s) => s.markdown?.includes(title))!.label as "A" | "B";

beforeEach(() => {
  relay.calls = [];
  relay.answer = { claude_work: plan("Stretch daily", "Stretch every morning."), codex: plan("Move more", "Walk after lunch.") };
});

describe("Compare", () => {
  it("sends both AIs the request Generate draft sends, byte for byte, and names neither before the pick", async () => {
    const id = session();
    const gen = await call("POST", `/api/workshop/sessions/${id}/generate`, { kind: "free", prompt: "Three reasons to stretch" });
    expect(gen.status).toBe(202);
    await until(async () => relay.calls.length, (k) => k === 1);
    const generated = relay.calls[0]!;
    relay.calls = [];

    const { status, body } = await start(id);
    expect(status).toBe(202);
    expect(body.compare!.sides.map((s) => s.status)).toEqual(["writing", "writing"]);
    const done = await finished(id);
    expect(relay.calls.map((c) => c.instance).sort()).toEqual(["claude_work", "codex"]);
    for (const c of relay.calls) {
      expect(c.system).toBe(generated.system);
      expect(c.user).toBe(generated.user);
    }
    expect(done.sides.map((s) => s.status)).toEqual(["ready", "ready"]);
    expect(done.sides.map((s) => s.label)).toEqual(["A", "B"]);
    for (const text of seen) expect(text).not.toMatch(NAMES);
    expect(done.sides.every((s) => !s.ai)).toBe(true);
  });

  it("puts the pick into the session as a generated draft and its piece, and names both AIs after", async () => {
    const id = session();
    // the session was opened: its Notes and working piece exist, so a draft no longer becomes a piece on open
    const before = (await (await call("GET", `/api/workshop/sessions/${id}/docs`)).json()) as Array<{ kind: string }>;
    await start(id);
    const done = await finished(id);
    const side = sideOf(done, "Walk after lunch.");
    const r = await call("POST", `/api/x/compare/sessions/${id}/pick`, { side });
    expect(r.status).toBe(200);
    const after = ((await r.json()) as { compare: View }).compare;
    expect(after.picked).toBe(side);
    expect(after.sides.find((s) => s.label === side)!.ai).toMatchObject({ name: "Codex", model: "gpt-6-luna" });
    expect(after.sides.find((s) => s.label !== side)!.ai).toMatchObject({ name: "Claude (work)", model: "opus" });
    // the other is thrown away
    expect(after.sides.every((s) => !s.markdown)).toBe(true);
    const stored = (JSON.parse(readFileSync(path.join(dataDir, "plugins", "compare", "nico.json"), "utf8")) as { compares: Array<{ sessionId: string }> }).compares.find((x) => x.sessionId === id);
    expect(JSON.stringify(stored)).not.toMatch(/Stretch every morning|Walk after lunch/);

    const drafts = (await (await call("GET", `/api/workshop/sessions/${id}/drafts`)).json()) as Array<{ id: string; status: string; title: string; kind: string }>;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: "ready", title: "Move more", kind: "free" });
    const got = (await (await call("GET", `/api/workshop/sessions/${id}/drafts/${drafts[0]!.id}`)).json()) as { markdown: string };
    expect(got.markdown).toContain("Walk after lunch.");
    const docs = (await (await call("GET", `/api/workshop/sessions/${id}/docs`)).json()) as Array<{ id: string; kind: string; title: string; blocks: Array<{ text: string; author: string }> }>;
    expect(docs).toHaveLength(before.length + 1);
    const piece = docs.find((d) => d.title === "Move more")!;
    expect(piece.kind).toBe("free");
    expect(piece.blocks.map((b) => b.text).join("\n")).toContain("Walk after lunch.");
    expect(piece.blocks.every((b) => b.author === "ai")).toBe(true);

    const tally = (await (await call("GET", "/api/x/compare/tally")).json()) as { rows: Array<{ name: string; counts: Record<string, number> }> };
    expect(tally.rows.find((t) => t.name === "Codex")?.counts.free).toBeGreaterThanOrEqual(1);
    expect((await call("POST", `/api/x/compare/sessions/${id}/pick`, { side })).status).toBe(409);
  });

  it("a pick in a session never opened becomes one piece on its first open, not two", async () => {
    const id = session();
    await start(id);
    const done = await finished(id);
    expect((await call("POST", `/api/x/compare/sessions/${id}/pick`, { side: sideOf(done, "Stretch every morning.") })).status).toBe(200);
    const docs = (await (await call("GET", `/api/workshop/sessions/${id}/docs`)).json()) as Array<{ kind: string; title: string }>;
    expect(docs.filter((d) => d.title === "Stretch daily")).toHaveLength(1);
    expect(docs.map((d) => d.kind).sort()).toEqual(["free", "notes"]);
  });

  it("Neither leaves the session as it was and counts nothing", async () => {
    const id = session();
    await call("GET", `/api/workshop/sessions/${id}/docs`);
    const docsBefore = await (await call("GET", `/api/workshop/sessions/${id}/docs`)).text();
    const tallyBefore = await (await call("GET", "/api/x/compare/tally")).text();
    await start(id);
    await finished(id);
    const r = await call("POST", `/api/x/compare/sessions/${id}/pick`, { side: null });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { compare: View }).compare.picked).toBe("neither");
    expect(await (await call("GET", `/api/workshop/sessions/${id}/drafts`)).json()).toEqual([]);
    expect(await (await call("GET", `/api/workshop/sessions/${id}/docs`)).text()).toBe(docsBefore);
    expect(await (await call("GET", "/api/x/compare/tally")).text()).toBe(tallyBefore);
  });

  it("one AI failing shows its sentence with no AI named, and the other can still be picked", async () => {
    const id = session();
    relay.answer.codex = async () => {
      throw new MacClaudeError("Codex (Mac) is not signed in: run codex login on Nico's Mac", "failed");
    };
    await start(id);
    const done = await finished(id);
    const failed = done.sides.find((s) => s.status === "error")!;
    expect(failed.error).toBe("The AI (Mac) is not signed in: run the AI login on the AI");
    for (const text of seen) expect(text).not.toMatch(NAMES);
    const ok = done.sides.find((s) => s.status === "ready")!;
    expect((await call("POST", `/api/x/compare/sessions/${id}/pick`, { side: failed.label })).status).toBe(400);
    const r = await call("POST", `/api/x/compare/sessions/${id}/pick`, { side: ok.label });
    expect(r.status).toBe(200);
    // after the pick the sentence is the AI's own
    expect(((await r.json()) as { compare: View }).compare.sides.find((s) => s.label === failed.label)!.error).toContain("Codex (Mac) is not signed in");
  });

  it("an AI at its usage limit fails its own side: the call never moves to the other AI", async () => {
    const id = session();
    relay.answer.claude_work = async () => {
      throw new MacClaudeError("You've hit your limit", "limit");
    };
    await start(id);
    const done = await finished(id);
    expect(relay.calls.map((c) => c.instance).sort()).toEqual(["claude_work", "codex"]);
    expect(done.sides.map((s) => s.status).sort()).toEqual(["error", "ready"]);
  });

  it("refuses the same AI twice, an AI that isn't the person's, and a second compare while one runs", async () => {
    const id = session();
    expect((await start(id, { b: CLAUDE })).status).toBe(400);
    expect((await start(id, { b: { instance: "ghost", model: "x", effort: "high" } })).body.error).toBe("One of these AIs can't run now: check it in Settings → Providers");
    let release = () => {};
    relay.answer.codex = () => new Promise((res) => (release = () => res(JSON.stringify({ title: "Late", markdown: "Late." }))));
    expect((await start(id)).status).toBe(202);
    expect((await start(id)).status).toBe(409);
    expect((await call("POST", `/api/x/compare/sessions/${id}/pick`, { side: null })).status).toBe(409);
    await until(async () => relay.calls.length, (k) => k === 2);
    release();
    await finished(id);
  });

  it("keeps at most PICKS_MAX picks and COMPARES_MAX compares, newest first", async () => {
    const file = path.join(dataDir, "plugins", "compare", "nico.json");
    const old = JSON.parse(readFileSync(file, "utf8")) as { compares: Array<{ sessionId: string }>; picks: unknown[] };
    const fill = Array.from({ length: PICKS_MAX }, (_, i) => ({ at: i, kind: "reel", instance: "codex", model: "gpt-6-luna", name: "Codex" }));
    const others = Array.from({ length: COMPARES_MAX }, (_, i) => ({ ...old.compares[0]!, id: `old-${i}`, sessionId: `old-${i}` }));
    writeFileSync(file, JSON.stringify({ compares: others, picks: fill }));
    const id = session();
    await start(id);
    const done = await finished(id);
    await call("POST", `/api/x/compare/sessions/${id}/pick`, { side: sideOf(done, "Stretch every morning.") });
    const kept = JSON.parse(readFileSync(file, "utf8")) as { compares: Array<{ sessionId: string }>; picks: Array<{ name: string; kind: string }> };
    expect(kept.picks).toHaveLength(PICKS_MAX);
    expect(kept.picks[0]).toMatchObject({ name: "Claude (work)", kind: "free" });
    expect(kept.compares).toHaveLength(COMPARES_MAX);
    expect(kept.compares[0]!.sessionId).toBe(id);
    const tally = (await (await call("GET", "/api/x/compare/tally")).json()) as { rows: Array<{ name: string; counts: Record<string, number> }> };
    expect(tally.rows).toEqual([
      { name: "Codex", model: "gpt-6-luna", counts: { reel: PICKS_MAX - 1 } },
      { name: "Claude (work)", model: "opus", counts: { free: 1 } },
    ]);
  });

  it("another person's pack text reaches both AIs when both run without tools, as in Generate draft, and neither when one has tools", async () => {
    const LINE = "Tiny Acrobatics pack line: open on the result.";
    await installPack("nico", { format: 1, id: "tiny-hooks", name: "Tiny Hooks", version: "1.0.0", author: "Tiny Acrobatics", license: "CC-BY-4.0", description: "Hook habits.", instructions: { "workshop.write": LINE } }, 0);
    const id = session();
    await call("POST", `/api/workshop/sessions/${id}/generate`, { kind: "free", prompt: "Three reasons to stretch" });
    await until(async () => relay.calls.length, (k) => k === 1);
    const generated = relay.calls[0]!;
    expect(generated.system + generated.user).toContain(LINE);
    relay.calls = [];
    await start(id);
    await finished(id);
    expect(relay.calls.map((c) => c.system + c.user)).toEqual([generated.system + generated.user, generated.system + generated.user]);
    await call("POST", `/api/x/compare/sessions/${id}/pick`, { side: null });
    relay.calls = [];
    relay.answer.agent = plan("Agent", "Stretch at noon.");
    await start(id, { b: { instance: "agent", model: "local", effort: "high" } });
    await finished(id);
    expect(relay.calls.map((c) => c.instance).sort()).toEqual(["agent", "claude_work"]);
    for (const c of relay.calls) expect(c.system + c.user).not.toContain(LINE);
    expect(relay.calls[0]!.system + relay.calls[0]!.user).toBe(relay.calls[1]!.system + relay.calls[1]!.user);
  });

  it("another account can neither read nor pick a compare, and an account with the plug-in off gets nothing", async () => {
    const id = session();
    await start(id);
    await finished(id);
    const ola = as("ola");
    expect((await ola("GET", `/api/x/compare/sessions/${id}`)).status).toBe(404);
    expect((await ola("POST", `/api/x/compare/sessions/${id}/pick`, { side: "A" })).status).toBe(404);
    expect(((await (await ola("GET", "/api/x/compare/tally")).json()) as { rows: unknown[] }).rows).toEqual([]);
    // an admin may open the session, but the compare is nico's own
    const ada = as("ada", [], "admin");
    expect(await (await ada("GET", `/api/x/compare/sessions/${id}`)).json()).toEqual({ compare: null });
    expect((await ada("POST", `/api/x/compare/sessions/${id}/pick`, { side: "A" })).status).toBe(404);
    const off = as("nico", ["compare"]);
    expect((await off("GET", `/api/x/compare/sessions/${id}`)).status).toBe(403);
    expect((await off("POST", `/api/x/compare/sessions/${id}`, { a: CLAUDE, b: CODEX, kind: "free", prompt: "x" })).status).toBe(403);
  });
});
