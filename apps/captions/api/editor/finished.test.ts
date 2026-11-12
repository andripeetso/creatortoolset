import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sentence, Timeline } from "../../contracts/editor";
import {
  FINISHED_BRIEF_MAX,
  FINISHED_CUT_LINES,
  FINISHED_CUT_MAX,
  FINISHED_EXAMPLE_MAX,
  FINISHED_EXAMPLES,
  FINISHED_MAX,
  FINISHED_SAID_MAX,
  type EditingStyle,
  type FinishedEdit,
} from "../../contracts/editor-styles";

// An editing style learns from the edits its maker finished (finished.ts), and can name one skill for the script step.
// Every test drives the real routes: the editor's, Review's approval and share link, the assistant's tools. The AI is
// a stand-in that answers the script step and whose request is read back.

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(m.aiFor), completeWithFallback: vi.fn(m.completeWithFallback) };
});

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-finished-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-finished-test-secret";
delete process.env.ANTHROPIC_API_KEY;

const { aiFor, completeWithFallback } = await import("../ai-complete");
const { innerCall } = await import("../auth");
const { createUser, newApiKey, setOff } = await import("../users");
const app = (await import("../boot")).default;
// A loaded plug-in that replaces /api/editor answers the root itself, so these tests (which drive the built-in root) run only without one.
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { addSkill, removeSkill, skillText, updateSkill } = await import("../lib/skills");
const { INSTRUCTIONS_MAX } = await import("../lib/workshop/prompt");
const { addVersion, reviewJobsDone } = await import("../review");
const { closestFinished, FINISHED_BLOCK_MAX, FINISHED_INTRO, finishedBlock, finishedExample } = await import("./finished");
const { editDir, readEdit, readStep, saveDraft, saveStep } = await import("./store");
const { tick } = await import("./worker");

type Sent = { system: string; user: string };
const cookies: Record<string, string> = {};
const keys: Record<string, string> = {};
function account(username: string, role: "user" | "admin" = "user") {
  const u = createUser(username, "password1", { role });
  setOff(u, []);
  keys[username] = `Bearer ${newApiKey(u, "full")}`;
}
async function login(username: string) {
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const req = (headers: Record<string, string>, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
/** A request from the person's own screen: their session cookie. */
const call = (user: string, method: string, url: string, body?: unknown) => req({ cookie: cookies[user]! }, method, url, body);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
/** One of the assistant's tools, called with the account's AI key. */
const tool = async (user: string, name: string, args: Record<string, unknown>) => {
  const r = await json(req({ authorization: keys[user]! }, "POST", "/api/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));
  const text = r.result.content[0].text as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { error: !!r.result.isError, text, value: (r.result.isError || !/^[[{]/.test(text) ? text : JSON.parse(text)) as any };
};

const style = (user: string, body: object) => json<EditingStyle>(call(user, "POST", "/api/editor/styles", body));
const finished = (user: string, styleId: string) => json<FinishedEdit[]>(call(user, "GET", `/api/editor/styles/${styleId}/finished`));
const fileOf = (user: string, styleId: string) => path.join(dir, "editor-styles", user, `${styleId}.finished.json`);
const approve = (user: string, asset: string, status = "approved") => call(user, "POST", `/api/review/assets/${asset}/approval`, { status });

/** What is spoken in the footage: six sentences, three in each file. */
const SPOKEN = ["Do puppies need tummy time?", "Um so I wanted to say hi first.", "Yes, a little every day.", "Start with one minute.", "Then add a minute each week.", "See you in class."];
const sentencesOf = (texts: string[]): Sentence[] => texts.map((text, i) => ({ n: i + 1, src: i < 3 ? "ver_a" : "ver_b", text, s: i, e: i + 0.5, w0: 0, w1: 0 }));
/** The stand-in AI's plan: one line a sentence (the fifth belongs to no line), every word of its own marked. */
const planOf = (count: number, skip = [5]) => {
  const ns = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !skip.includes(n));
  return {
    lines: ns.map((n) => ({ id: `L${n}`, text: `AI-WROTE line ${n}`, takes: [{ first: n, last: n, score: 0.9 }] })),
    versions: [{ name: "AI-TITLE of the cut", lines: ns.map((n) => `L${n}`) }],
  };
};
const timeline = (seconds: number): Timeline => ({
  name: "v1",
  fps: 25,
  width: 1080,
  height: 1920,
  sources: {},
  tracks: { V1: { name: "Speaker", items: [{ src: "ver_a", in: 0, len: seconds * 25, rec: 0 }] }, V2: { name: "B-roll", items: [] }, A1: { name: "Voice", items: [] }, A2: { name: "Music", items: [] }, A3: { name: "SFX", items: [] } },
  markers: [],
});
const noJobs = () => libraryDb().prepare("DELETE FROM edit_jobs").run();

/** Runs an edit's script step against the stand-in AI and gives back what it was sent. */
async function script(user: string, id: string, spoken = SPOKEN): Promise<Sent> {
  await saveStep(id, "analysis", { sentences: sentencesOf(spoken), notes: [] });
  let got = { system: "", user: "" };
  vi.mocked(aiFor).mockReturnValueOnce({ only: ["anthropic"], apiKey: "test", mac: { label: "AI Editor script" } });
  vi.mocked(completeWithFallback).mockImplementationOnce(async (system, userText, _c, parse) => {
    got = { system, user: userText };
    return parse(JSON.stringify(planOf(spoken.length, spoken === SPOKEN ? [5] : [])));
  });
  noJobs(); // tick takes the oldest step
  enqueueJob(libraryDb(), user, `${id}:`, "script", user, true, "edit_jobs");
  await tick();
  expect(libraryDb().prepare("SELECT state, error FROM edit_jobs WHERE edit_id = ? AND kind = 'script'").get(id)).toEqual({ state: "done", error: null });
  noJobs(); // the draft it queued: the tests file a draft themselves
  return got;
}

/** A new edit's script step, and what it sent. */
async function sent(user: string, body: object): Promise<Sent> {
  const { id } = await json<{ id: string }>(call(user, "POST", "/api/editor", { sources: ["ver_a", "ver_b"], ...body }));
  return script(user, id);
}

/** The person takes lines out of version v1 in the script table (PUT lines). */
async function takeOut(user: string, id: string, gone: string[]) {
  const v1 = readStep(id, "plan")!.plans[0]!;
  const res = await call(user, "PUT", `/api/editor/${id}/lines`, { plans: [{ name: "v1", lines: v1.lines.filter((l) => !gone.includes(l.line)) }] });
  expect(res.status).toBe(200);
  noJobs();
}

/** The edit's v1 gets a draft of `seconds` and its preview is filed in Review, as the preview step files it. Gives the Review video's id. */
async function preview(user: string, id: string, seconds = 41): Promise<string> {
  await saveDraft(id, "v1", { timeline: timeline(seconds), notes: [] });
  const added = await addVersion(undefined, { owner: user, name: "Tiny Acrobatics hook v1.mp4", mime: "video/mp4", bytes: 1 }, async () => {});
  await reviewJobsDone();
  await saveStep(id, "review", { ...readStep(id, "review"), v1: { assetId: added!.meta.id, n: 1 } });
  return added!.meta.id;
}

/** An edit made at the person's own screen, scripted and with its preview in Review. */
async function made(user: string, body: object, opts: { gone?: string[]; seconds?: number; spoken?: string[] } = {}) {
  const { id } = await json<{ id: string }>(call(user, "POST", "/api/editor", { name: "Tiny Acrobatics hook", sources: ["ver_a", "ver_b"], ...body }));
  const prompt = await script(user, id, opts.spoken);
  if (opts.gone) await takeOut(user, id, opts.gone);
  return { id, asset: await preview(user, id, opts.seconds), prompt };
}

beforeAll(async () => {
  account("maker");
  account("other");
  account("boss", "admin");
  for (const u of ["maker", "other", "boss"]) await login(u);
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'maker', 'A', 'local', 0), ('lib_b', 'other', 'B', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_a', 'lib_a', 'video', 'Take A', 'maker', 0), ('ast_b', 'lib_a', 'video', 'Take B', 'maker', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES
      ('ver_a', 'ast_a', 1, 'k1', 1, 'x1', 'ready', 'maker', 0), ('ver_b', 'ast_b', 1, 'k2', 1, 'x2', 'ready', 'maker', 0);
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(rootReplaced)("Finished edits: what is kept, and whose words", () => {
  it("an edit with no style keeps nothing when its maker approves it", async () => {
    const e = await made("maker", { brief: "A reel for parents of crawlers." });
    expect((await approve("maker", e.asset)).status).toBe(200);
    expect(existsSync(path.join(dir, "editor-styles", "maker"))).toBe(false);
  });

  it("the maker approves an edit made with a style: it is kept as it was, in their words and the spoken ones, and no line the AI wrote gets in", async () => {
    const s = await style("maker", { name: "Fast and warm", notes: "Short lines. No intro." });
    expect(await finished("maker", s.id)).toEqual([]);
    const e = await made("maker", { style: s.id, brief: "A reel for parents of crawlers.\nWarm and slow.", script: "SCRIPT-TEXT the takes were read from", targetS: 45 }, { gone: ["L2"] });
    // the plan is the AI's: its line texts and its title for the version are on the edit
    expect(JSON.stringify(readStep(e.id, "plan"))).toMatch(/AI-WROTE line 1.*AI-TITLE of the cut/s);
    const before = Date.now();
    expect((await approve("maker", e.asset)).status).toBe(200);

    const list = await finished("maker", s.id);
    expect(list).toEqual([
      {
        editId: e.id,
        variant: "v1",
        name: "Tiny Acrobatics hook",
        at: expect.any(Number),
        brief: "A reel for parents of crawlers.\nWarm and slow.",
        targetS: 45,
        seconds: 41,
        // the takes of the lines still in the cut, as the transcript has them; sentence 5 was in no line
        said: "Do puppies need tummy time?\nYes, a little every day.\nStart with one minute.\nSee you in class.",
        // the line the AI planned and the person took out, as it was spoken
        cut: ["Um so I wanted to say hi first."],
      },
    ]);
    expect(list[0]!.at).toBeGreaterThanOrEqual(before);
    // the file itself: nothing the AI wrote, and not the script text
    const raw = readFileSync(fileOf("maker", s.id), "utf8");
    expect(JSON.parse(raw)).toEqual(list);
    expect(raw).not.toMatch(/AI-WROTE|AI-TITLE|SCRIPT-TEXT/);
    // the plan as the AI first gave it is kept by number only
    expect(JSON.stringify(readStep(e.id, "first"))).not.toMatch(/AI-WROTE|AI-TITLE/);
    expect(readStep(e.id, "first")!.plans[0]!.lines.map((l) => l.line)).toEqual(["L1", "L2", "L3", "L4", "L6"]);

    // the next edit in the style is shown it, and still nothing the AI wrote
    const next = await sent("maker", { style: s.id, brief: "A reel about crawlers and tummy time.", targetS: 30 });
    expect(next.user).toContain(`Target length: about 30 seconds\n\n${FINISHED_INTRO}\n\nFinished edit 1\nBrief: A reel for parents of crawlers. Warm and slow.\nLength: 41 seconds (target: about 45 seconds)\nWhat is said in it, in order:\nDo puppies need tummy time?\nYes, a little every day.\nStart with one minute.\nSee you in class.\nLines planned for it that the author took out:\n- Um so I wanted to say hi first.\n\nSources:\n`);
    expect(`${next.system}${next.user}`).not.toMatch(/AI-WROTE|AI-TITLE|SCRIPT-TEXT|Tiny Acrobatics hook/);

    // approving it again keeps one record of it, as it is now
    await takeOut("maker", e.id, ["L2", "L4"]);
    await approve("maker", e.asset, "needs_review");
    await approve("maker", e.asset);
    const again = await finished("maker", s.id);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ said: "Do puppies need tummy time?\nYes, a little every day.\nSee you in class.", cut: ["Um so I wanted to say hi first.", "Start with one minute."] });
  });

  it("an edit an AI's tool made: its name and its brief are the AI's, so neither is kept; a brief the person types afterwards is", async () => {
    const s = await style("maker", { name: "From the assistant" });
    for (const how of ["tool", "key"] as const) {
      const words = { name: "AI-NAME for the edit", brief: "AI-BRIEF about the launch" };
      const id: string =
        how === "tool"
          ? (await tool("maker", "editor_create", { sources: ["ver_a", "ver_b"], ...words, start: false })).value.id
          : (await json(req({ authorization: keys.maker! }, "POST", "/api/editor", { sources: ["ver_a", "ver_b"], ...words }))).id;
      expect(readEdit(id)).toMatchObject({ ...words, byTool: ["name", "brief"] });
      // the mark is the server's own: the edit as the pages and the tools read it does not carry it
      expect("byTool" in (await json(call("maker", "GET", `/api/editor/${id}`)))).toBe(false);
      // the person puts the style on it themselves: the words are still the tool's
      expect((await call("maker", "PATCH", `/api/editor/${id}`, { style: s.id })).status).toBe(200);
      await script("maker", id);
      const asset = await preview("maker", id);
      await approve("maker", asset);
      const [kept] = await finished("maker", s.id);
      expect(kept).toMatchObject({ editId: id, name: "", brief: "", said: expect.stringContaining("Do puppies need tummy time?") });
      expect(readFileSync(fileOf("maker", s.id), "utf8")).not.toMatch(/AI-NAME|AI-BRIEF|AI-WROTE|AI-TITLE/);

      // they type the brief themselves: it is theirs now, and the name is still not
      await call("maker", "PATCH", `/api/editor/${id}`, { brief: "Typed by me: tummy time for new parents." });
      expect(readEdit(id)!.byTool).toEqual(["name"]);
      await approve("maker", asset, "needs_review");
      await approve("maker", asset);
      expect((await finished("maker", s.id))[0]).toMatchObject({ editId: id, name: "", brief: "Typed by me: tummy time for new parents." });
      // and a tool that rewrites it makes it the tool's again
      await req({ authorization: keys.maker! }, "PATCH", `/api/editor/${id}`, { brief: "AI-BRIEF again" });
      expect(readEdit(id)!.byTool).toEqual(["name", "brief"]);
    }
    // an edit the person made themselves has no such mark
    const own = await made("maker", { style: s.id, brief: "Mine." });
    expect("byTool" in JSON.parse(readFileSync(path.join(editDir(own.id), "edit.json"), "utf8"))).toBe(false);
  });
});

describe.skipIf(rootReplaced)("Finished edits: only the edit's own maker finishes it", () => {
  it("a reviewer on the share link, another account, an admin, an AI key and the assistant's tool approve it: nothing is kept; the maker's own press keeps it", async () => {
    const s = await style("maker", { name: "Only mine" });
    const e = await made("maker", { style: s.id, brief: "Whose press counts." });
    const token = (await json(call("maker", "PATCH", `/api/review/assets/${e.asset}`, { share: { enabled: true } }))).share.token as string;
    const link = `/api/review/s/${token}/approval`;
    const status = async () => (await json(call("maker", "GET", `/api/review/assets/${e.asset}`))).asset.approval;

    // a guest on the link, who types the maker's own name
    expect((await req({}, "POST", link, { status: "approved", author: "maker" })).status).toBe(200);
    expect(await status()).toMatchObject({ status: "approved", by: "maker" });
    expect(await finished("maker", s.id)).toEqual([]);
    // another signed-in account on the link
    expect((await call("other", "POST", link, { status: "approved" })).status).toBe(200);
    expect(await status()).toMatchObject({ status: "approved", by: "other" });
    expect(await finished("maker", s.id)).toEqual([]);
    // an admin, who can manage every video
    expect((await approve("boss", e.asset)).status).toBe(200);
    expect(await status()).toMatchObject({ status: "approved", by: "boss" });
    expect(await finished("maker", s.id)).toEqual([]);
    // the maker's own AI key, straight at the route
    expect((await req({ authorization: keys.maker! }, "POST", `/api/review/assets/${e.asset}/approval`, { status: "approved" })).status).toBe(200);
    expect(await finished("maker", s.id)).toEqual([]);
    // the assistant's tool, as the maker
    expect((await tool("maker", "review_set_approval", { link: e.asset, status: "approved" })).value).toMatchObject({ approval: "approved" });
    expect(await status()).toMatchObject({ status: "approved", by: "maker" });
    expect(await finished("maker", s.id)).toEqual([]);
    // a tool's call that runs after Yes on a card: the person's own session, inside a tool call
    expect((await innerCall.run({ username: "maker", role: "user", cloud: false, off: [] }, () => approve("maker", e.asset))).status).toBe(200);
    expect(await finished("maker", s.id)).toEqual([]);
    expect(existsSync(fileOf("maker", s.id))).toBe(false);

    // the maker sends it back: not finished
    await approve("maker", e.asset, "changes");
    expect(await finished("maker", s.id)).toEqual([]);
    // the maker approves it at their own screen
    expect((await approve("maker", e.asset)).status).toBe(200);
    expect((await finished("maker", s.id)).map((r) => r.editId)).toEqual([e.id]);

    // the list is the maker's alone
    expect((await call("other", "GET", `/api/editor/styles/${s.id}/finished`)).status).toBe(404);
    expect((await call("other", "DELETE", `/api/editor/styles/${s.id}/finished/${e.id}`)).status).toBe(404);
    expect((await finished("maker", s.id)).map((r) => r.editId)).toEqual([e.id]);
  });
});

describe.skipIf(rootReplaced)("Finished edits: fixed in size", () => {
  const long = (word: string, n: number) => Array.from({ length: n }, () => word).join(" ");

  it(`one record: a brief of ${FINISHED_BRIEF_MAX} characters, ${FINISHED_SAID_MAX} of what was said, ${FINISHED_CUT_LINES} lines taken out of ${FINISHED_CUT_MAX} each`, async () => {
    const s = await style("maker", { name: "At the caps" });
    // twelve long sentences; the person takes seven of the planned lines out
    const spoken = Array.from({ length: 12 }, (_, i) => `Sentence ${i + 1} ${long("spoken", 40)}.`);
    const e = await made("maker", { style: s.id, brief: long("brief", 300) }, { spoken, gone: ["L1", "L2", "L3", "L4", "L5", "L6", "L7"] });
    await approve("maker", e.asset);
    const [r] = await finished("maker", s.id);
    expect(r!.brief).toHaveLength(FINISHED_BRIEF_MAX);
    expect(r!.said).toHaveLength(FINISHED_SAID_MAX);
    expect(r!.said.startsWith("Sentence 8 spoken")).toBe(true);
    expect(r!.cut).toHaveLength(FINISHED_CUT_LINES);
    expect(r!.cut.map((c) => c.length)).toEqual(Array(FINISHED_CUT_LINES).fill(FINISHED_CUT_MAX));
    expect(r!.cut.map((c) => c.slice(0, 10))).toEqual(["Sentence 1", "Sentence 2", "Sentence 3", "Sentence 4", "Sentence 5"]);
    // what was cut short says so
    expect([r!.brief, r!.said, ...r!.cut].every((t) => t.endsWith("…"))).toBe(true);
    expect(JSON.parse(readFileSync(fileOf("maker", s.id), "utf8"))).toEqual([r]);
  });

  it(`a style keeps ${FINISHED_MAX}: one more and the oldest goes`, async () => {
    const s = await style("maker", { name: "Twenty" });
    const ids: string[] = [];
    for (let i = 0; i <= FINISHED_MAX; i++) {
      const e = await made("maker", { style: s.id, brief: `Edit number ${i}` });
      await approve("maker", e.asset);
      ids.push(e.id);
      if (i === FINISHED_MAX - 1) expect(await finished("maker", s.id)).toHaveLength(FINISHED_MAX);
    }
    const list = await finished("maker", s.id);
    expect(list).toHaveLength(FINISHED_MAX);
    // newest first, and the first one made is gone
    expect(list.map((r) => r.editId)).toEqual(ids.slice(1).reverse());
    expect(JSON.parse(readFileSync(fileOf("maker", s.id), "utf8"))).toHaveLength(FINISHED_MAX);
  }, 30_000); // 21 whole edits through the real routes: over a second alone, more beside the rest of the suite

  it("a file changed by hand gives no more: the caps hold where it is read", async () => {
    const s = await style("maker", { name: "By hand" });
    const fat = (i: number) => ({ editId: `e${i}`, variant: "v1", name: "n".repeat(900), at: i, brief: "b".repeat(5000), targetS: 30, seconds: 30, said: "s".repeat(5000), cut: Array(40).fill("c".repeat(900)) });
    mkdirSync(path.dirname(fileOf("maker", s.id)), { recursive: true });
    writeFileSync(fileOf("maker", s.id), JSON.stringify(Array.from({ length: 50 }, (_, i) => fat(i))));
    const list = await finished("maker", s.id);
    expect(list).toHaveLength(FINISHED_MAX);
    expect(list.every((r) => r.brief.length === FINISHED_BRIEF_MAX && r.said.length === FINISHED_SAID_MAX && r.cut.length === FINISHED_CUT_LINES && r.cut.every((c) => c.length === FINISHED_CUT_MAX))).toBe(true);
    // and the script step of the next edit gets exactly the most it ever can
    const plain = await sent("maker", { brief: "b b b", targetS: 30 });
    const next = await sent("maker", { style: s.id, brief: "b b b", targetS: 30 });
    expect(next.system).toBe(plain.system);
    expect(next.user.length - plain.user.length).toBe("\n\n".length + FINISHED_BLOCK_MAX);
    const block = next.user.slice(next.user.indexOf(FINISHED_INTRO), next.user.indexOf("\n\nSources:\n"));
    expect(block).toHaveLength(FINISHED_BLOCK_MAX);
    expect(block.split(/\n\n(?=Finished edit \d\n)/).slice(1).map((x) => x.length)).toEqual(Array(FINISHED_EXAMPLES).fill(FINISHED_EXAMPLE_MAX));
  });

  it(`what the script step gets: ${FINISHED_EXAMPLES} examples of at most ${FINISHED_EXAMPLE_MAX} characters each, labels included`, () => {
    const full: FinishedEdit = { editId: "e", variant: "v1", name: "NAME-NOT-SENT", at: 1, brief: "b".repeat(FINISHED_BRIEF_MAX), targetS: 45, seconds: 41, said: "s".repeat(FINISHED_SAID_MAX), cut: Array(FINISHED_CUT_LINES).fill("c".repeat(FINISHED_CUT_MAX)) };
    const one = finishedExample(full, 1);
    expect(one).toHaveLength(FINISHED_EXAMPLE_MAX);
    expect(one).not.toContain("NAME-NOT-SENT");
    // at the caps every part is still there, each in its own share: the brief, what was said, and a line taken out
    expect(one).toMatch(/^Finished edit 1\nBrief: b{249}…\nLength: 41 seconds \(target: about 45 seconds\)\nWhat is said in it, in order:\ns{599}…\nLines planned for it that the author took out:\n- c{160}\n- c+…$/);
    // a short one is whole, and never padded
    const short = finishedExample({ ...full, brief: "", targetS: 0, said: "Hello there.", cut: [] }, 2);
    expect(short).toBe("Finished edit 2\nLength: 41 seconds\nWhat is said in it, in order:\nHello there.");
    expect(FINISHED_EXAMPLES).toBe(2);
    expect(FINISHED_EXAMPLE_MAX).toBe(1200);
    expect(FINISHED_BLOCK_MAX).toBe(FINISHED_INTRO.length + 2 * (2 + 1200));
    expect(FINISHED_INTRO.length).toBeLessThan(200);
  });
});

describe.skipIf(rootReplaced)("Finished edits: which ones the script step is shown", () => {
  const rec = (editId: string, at: number, brief: string): FinishedEdit => ({ editId, variant: "v1", name: "", at, brief, targetS: 0, seconds: 30, said: `Said in ${editId}.`, cut: [] });

  it("the two closest by the words of the brief; with no brief, or none that is close, the newest two", () => {
    // newest first, as the store keeps them
    const list = [
      rec("newest", 5, "Packing list for the summer camp."),
      rec("second", 4, "How we warm up before handstands."),
      rec("swim", 3, "Swimming lessons for beginners: floating and kicking."),
      rec("tummy", 2, "Tummy time for crawlers on the mat."),
      rec("oldest", 1, "Swimming goggles: which ones fit beginners."),
    ];
    const ids = (brief: string) => closestFinished(brief, list).map((r) => r.editId);
    expect(ids("A reel about swimming with beginners: floating first.")).toEqual(["swim", "oldest"]);
    expect(ids("Tummy time on the mat")).toEqual(["tummy", "newest"]); // one is close: the newest fills the second place
    expect(ids("")).toEqual(["newest", "second"]);
    expect(ids("Juggling oranges")).toEqual(["newest", "second"]);
    expect(closestFinished("swimming beginners", list.slice(0, 1))).toHaveLength(1);
    expect(closestFinished("swimming beginners", [])).toEqual([]);
  });

  it("only an edit in that style, of that account, gets them, and an edit is never its own example", async () => {
    const s = await style("maker", { name: "Swim reels", notes: "Short lines." });
    const other = await style("maker", { name: "Long talks", notes: "Long takes." });
    const plain = await sent("maker", { brief: "Floating first.", targetS: 30 });
    const inOther = await sent("maker", { style: other.id, brief: "Floating first.", targetS: 30 });
    const a = await made("maker", { style: s.id, brief: "Swimming lessons for beginners: floating and kicking." });
    await approve("maker", a.asset);

    // an edit with no style, and one in another style: what they got before anything was finished
    expect(await sent("maker", { brief: "Floating first.", targetS: 30 })).toEqual(plain);
    expect(await sent("maker", { style: other.id, brief: "Floating first.", targetS: 30 })).toEqual(inOther);
    // an edit in the style: the same system text as the style gives, and the example in the user message
    const next = await sent("maker", { style: s.id, brief: "Floating first.", targetS: 30 });
    expect(next.system).toBe(inOther.system.replace(`Editing style "Long talks", in the author's own words:\nLong takes.`, `Editing style "Swim reels", in the author's own words:\nShort lines.`));
    expect(next.user).toBe(plain.user.replace("\n\nSources:\n", `\n\n${finishedBlock({ id: "x", createdBy: "maker", brief: "Floating first.", style: { id: s.id, name: "", notes: "", pace: "tight" } })}\n\nSources:\n`));
    expect(next.user).toContain("Finished edit 1\nBrief: Swimming lessons for beginners: floating and kicking.");
    expect(next.user).not.toContain("Finished edit 2");

    // the finished edit scripted again does not read itself
    expect((await script("maker", a.id)).user).not.toContain(FINISHED_INTRO);
    // another account has no such style: nothing of the maker's reaches it
    expect((await call("other", "POST", "/api/editor", { sources: ["ver_a"], style: s.id })).status).toBe(404);
    expect(finishedBlock({ id: "x", createdBy: "other", brief: "Floating first.", style: { id: s.id, name: "", notes: "", pace: "tight" } })).toBe("");
    expect(finishedBlock({ id: "x", createdBy: "maker", brief: "Floating first.", style: { id: "../../maker", name: "", notes: "", pace: "tight" } })).toBe("");
  });
});

describe.skipIf(rootReplaced)("Finished edits: taken off the list for good", () => {
  it("× removes one, and approving that edit again never files it again", async () => {
    const s = await style("maker", { name: "Removable" });
    const a = await made("maker", { style: s.id, brief: "The first." });
    const b = await made("maker", { style: s.id, brief: "The second." });
    await approve("maker", a.asset);
    await approve("maker", b.asset);
    expect((await finished("maker", s.id)).map((r) => r.editId)).toEqual([b.id, a.id]);

    expect((await call("maker", "DELETE", `/api/editor/styles/${s.id}/finished/${a.id}`)).status).toBe(200);
    expect((await call("maker", "DELETE", `/api/editor/styles/${s.id}/finished/${a.id}`)).status).toBe(404);
    expect((await finished("maker", s.id)).map((r) => r.editId)).toEqual([b.id]);
    await approve("maker", a.asset, "needs_review");
    expect((await approve("maker", a.asset)).status).toBe(200);
    expect((await finished("maker", s.id)).map((r) => r.editId)).toEqual([b.id]);
    // the next edit in the style is not shown it
    expect((await sent("maker", { style: s.id, brief: "The first again." })).user).not.toContain("Brief: The first.");
  });

  it("a deleted style takes its finished edits with it, and a later approval of one of its edits brings nothing back", async () => {
    const s = await style("maker", { name: "Going" });
    const a = await made("maker", { style: s.id, brief: "Kept for now." });
    const b = await made("maker", { style: s.id, brief: "Approved too late." });
    await approve("maker", a.asset);
    expect(existsSync(fileOf("maker", s.id))).toBe(true);
    expect((await call("maker", "DELETE", `/api/editor/styles/${s.id}`)).status).toBe(200);
    expect(existsSync(fileOf("maker", s.id))).toBe(false);
    expect((await call("maker", "GET", `/api/editor/styles/${s.id}/finished`)).status).toBe(404);
    await approve("maker", b.asset);
    expect(existsSync(fileOf("maker", s.id))).toBe(false);
    // an edit in the trash keeps nothing either
    const t = await style("maker", { name: "Trashed edit" });
    const c = await made("maker", { style: t.id, brief: "In the trash." });
    await call("maker", "DELETE", `/api/editor/${c.id}`);
    await approve("maker", c.asset);
    expect(await finished("maker", t.id)).toEqual([]);
  });
});

describe.skipIf(rootReplaced)("An editing style's skill", () => {
  it("its text reaches the script step only of an edit in a style that names it, after the style's notes; with none, or one that is off or gone, the prompt is what it was", async () => {
    const skill = await addSkill("maker", { name: "Hooks", when: "Writing the first line of a reel.", body: "SKILL-BODY Open on the question the viewer is asking." });
    const theirs = await addSkill("other", { name: "Theirs", when: "Never for the maker.", body: "OTHER-SKILL-BODY" });
    const bare = await style("maker", { name: "No skill", notes: "Short lines." });
    const s = await style("maker", { name: "With a skill", notes: "Short lines.", skill: skill.id });
    expect(s.skill).toBe(skill.id);
    expect("skill" in bare).toBe(false);
    expect((await call("maker", "POST", "/api/editor/styles", { name: "Bad", skill: 7 })).status).toBe(400);

    const brief = { brief: "A reel for parents of crawlers.", targetS: 45 };
    const plain = await sent("maker", brief);
    const noSkill = await sent("maker", { ...brief, style: bare.id });
    expect(noSkill.system).toBe(`${plain.system}\n\nEditing style "No skill", in the author's own words:\nShort lines.`);

    const got = await sent("maker", { ...brief, style: s.id });
    const text = await skillText("maker", [skill.id]);
    expect(text).toContain(`[Skill "Hooks"]\nSKILL-BODY Open on the question the viewer is asking.`);
    expect(got.system).toBe(`${plain.system}\n\nEditing style "With a skill", in the author's own words:\nShort lines.\n\n${text}`);
    expect(got.user).toBe(plain.user);
    // the edit keeps the skill's id, not its text
    const { id } = await json<{ id: string }>(call("maker", "POST", "/api/editor", { sources: ["ver_a"], style: s.id }));
    expect(readEdit(id)!.style).toEqual({ id: s.id, name: "With a skill", notes: "Short lines.", pace: "tight", skill: skill.id });
    expect(readFileSync(path.join(editDir(id), "edit.json"), "utf8")).not.toContain("SKILL-BODY");
    // an edit with no style, and one in a style that names none, get no skill
    expect(await sent("maker", brief)).toEqual(plain);
    expect(await sent("maker", { ...brief, style: bare.id })).toEqual(noSkill);

    // someone else's skill named by hand adds nothing
    const borrowed = await style("maker", { name: "Borrowed", notes: "Short lines.", skill: theirs.id });
    expect((await sent("maker", { ...brief, style: borrowed.id })).system).toBe(noSkill.system.replace("No skill", "Borrowed"));
    // switched off, then removed: the prompt of a style with no skill
    const same = noSkill.system.replace("No skill", "With a skill");
    await updateSkill("maker", skill.id, { on: false });
    expect((await sent("maker", { ...brief, style: s.id })).system).toBe(same);
    await updateSkill("maker", skill.id, { on: true });
    expect((await sent("maker", { ...brief, style: s.id })).system).toBe(got.system);
    await removeSkill("maker", skill.id);
    expect((await sent("maker", { ...brief, style: s.id })).system).toBe(same);
    // null takes it off the style
    expect((await json<EditingStyle>(call("maker", "PUT", `/api/editor/styles/${s.id}`, { skill: null }))).skill).toBeNull();
  });

  it("an AI Editor script skill, the person's own or from Community, reaches the script step only of an edit in a style that names it", async () => {
    const own = await addSkill("maker", { name: "Script hooks", body: "OWN-SCRIPT-SKILL Open on the roll.", place: "editor.script" });
    const pack = { format: 1, id: "tiny-scripts", name: "Tiny Scripts", version: "1.0.0", author: "Tiny Acrobatics", license: "CC-BY-4.0", description: "Script help.", skills: [{ slot: "editor.script", name: "Endings", text: "PACK-SCRIPT-SKILL End on the next class." }] };
    expect((await call("maker", "POST", "/api/packs/install", { pack })).status).toBe(201);
    const brief = { brief: "A reel for parents of crawlers.", targetS: 45 };
    const plain = await sent("maker", brief);
    expect(plain.system).not.toMatch(/OWN-SCRIPT-SKILL|PACK-SCRIPT-SKILL/);
    const withOwn = await style("maker", { name: "Hooks style", notes: "Short lines.", skill: own.id });
    const withPack = await style("maker", { name: "Endings style", notes: "Short lines.", skill: "pack:tiny-scripts:endings" });
    const other = await style("maker", { name: "Other style", notes: "Short lines." });
    const a = await sent("maker", { ...brief, style: withOwn.id });
    expect(a.system).toBe(`${plain.system}\n\nEditing style "Hooks style", in the author's own words:\nShort lines.\n\n${await skillText("maker", [own.id])}`);
    expect(a.system).toContain("OWN-SCRIPT-SKILL");
    expect(a.system).not.toContain("PACK-SCRIPT-SKILL");
    const b = await sent("maker", { ...brief, style: withPack.id });
    expect(b.system).toContain(`[Skill "Endings" from pack "Tiny Scripts"]\nPACK-SCRIPT-SKILL End on the next class.`);
    expect(b.system).not.toContain("OWN-SCRIPT-SKILL");
    expect((await sent("maker", { ...brief, style: other.id })).system).toBe(`${plain.system}\n\nEditing style "Other style", in the author's own words:\nShort lines.`);
    expect(await sent("maker", brief)).toEqual(plain);
    await removeSkill("maker", own.id);
    await call("maker", "DELETE", "/api/packs/tiny-scripts");
  });

  it("the skill's text is never more than the skills' own cap", async () => {
    const big = await addSkill("maker", { name: "Long", when: "Always.", body: "w".repeat(20_000) });
    const s = await style("maker", { name: "Long skill", skill: big.id });
    const plain = await sent("maker", { brief: "Any." });
    const got = await sent("maker", { brief: "Any.", style: s.id });
    const text = await skillText("maker", [big.id]);
    expect(text).toHaveLength(INSTRUCTIONS_MAX);
    expect(got.system).toBe(`${plain.system}\n\n${text}`);
    await removeSkill("maker", big.id);
  });

  it("Save as style from an edit copies the skill its style named", async () => {
    const skill = await addSkill("maker", { name: "Endings", when: "Writing the last line.", body: "End on the question." });
    const s = await style("maker", { name: "First", skill: skill.id });
    const { id } = await json<{ id: string }>(call("maker", "POST", "/api/editor", { sources: ["ver_a"], style: s.id }));
    expect((await style("maker", { fromEdit: id, name: "Second" })).skill).toBe(skill.id);
    const plainEdit = await json<{ id: string }>(call("maker", "POST", "/api/editor", { sources: ["ver_a"] }));
    expect("skill" in (await style("maker", { fromEdit: plainEdit.id, name: "Third" }))).toBe(false);
  });
});
