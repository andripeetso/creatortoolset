import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// the person's AI: the plan answer is the test's; a look at contact sheets must not happen (the library's lines are read)
vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(() => ({ only: ["mac"] })), completeWithFallback: vi.fn() };
});
vi.mock("../ai-vision", () => ({
  completeVisionWithFallback: vi.fn(async () => {
    throw new Error("the AI was asked to look at footage the library describes");
  }),
}));

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-flywheel-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-flywheel-test-secret";
delete process.env.ANTHROPIC_API_KEY;

const { AiProviderError, completeWithFallback } = await import("../ai-complete");
const { createUser, findUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { emitEvent } = await import("../lib/events");
const { MacClaudeError } = await import("../lib/mac-claude");
const { EDIT_FEEDBACK_MAX } = await import("../../contracts/editor");
const { editorTools } = await import("../mcp-tools/editor");
const { Waiting } = await import("./analyze");
const { indexSources, shotLog, STILL_WAITING_MS } = await import("./index");
const { planStep } = await import("./plan");
const { addFeedback, readEdit, readStep, saveStep } = await import("./store");
const { change, createStyle } = await import("./styles");
const { LIMIT_WAIT_S, limitWait, STEPS, tick } = await import("./worker");

const signal = new AbortController().signal;
let cookie = "";
const call = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route answers read loosely
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const create = async (sources: string[]) => (await json<{ id: string }>(call("POST", "/api/editor", { name: "Tiny Acrobatics hard edit", sources }))).id;
const jobsOf = (id: string) => libraryDb().prepare("SELECT kind, state FROM edit_jobs WHERE edit_id = ? ORDER BY id").all(id);
const ph = (seed: string) => createHash("sha256").update(seed).digest("hex").slice(0, 16);

/** Six recordings: four described shot by shot, one the library could not read, one still being described. */
const FILES = [
  { v: "ver_1", title: "Tiny Acrobatics castle run", dur: 60 },
  { v: "ver_2", title: "Tiny Acrobatics boss fight", dur: 48 },
  { v: "ver_3", title: "Tiny Acrobatics town", dur: 36 },
  { v: "ver_4", title: "Tiny Acrobatics arena", dur: 36 },
  { v: "ver_5", title: "Broken file", dur: 0 },
  { v: "ver_6", title: "Still describing", dur: 30 },
];
let stamp = "";
let projectId: string | undefined;

/** A file's shot descriptions, one every 6 s, written under `stamp`. */
function describe6(v: string, dur: number, act: (k: number) => number, picture = (k: number) => ph(`${v}:${k}`)) {
  const q = libraryDb().prepare("INSERT INTO stretches (version_id, seg, a, b, motion, action, clear, tags, text, ph, source, stamp, created_at) VALUES (?, ?, ?, ?, 0.5, ?, ?, ?, ?, ?, 'ai', ?, 0)");
  for (let k = 0; k * 6 < dur; k++) q.run(v, k, k * 6, k * 6 + 6, act(k), k % 2 ? 0 : 1, JSON.stringify(["fight"]), `${v} stretch ${k}: two riders clash at the gate`, picture(k), stamp);
}

beforeAll(async () => {
  setOff(createUser("maker", "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "maker", password: "password1" }) });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const db = libraryDb();
  db.exec("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'maker', 'A', 'local', 0)");
  for (const f of FILES) {
    const probe = f.v === "ver_5" ? null : JSON.stringify({ duration: f.dur, width: 1920, height: 1080, fps: 30, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" });
    db.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, 'maker', 0)").run(`a_${f.v}`, f.title);
    db.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, ?, ?, 'maker', 0)").run(f.v, `a_${f.v}`, `k_${f.v}`, `s_${f.v}`, probe, f.v === "ver_5" ? "failed" : "ready");
    enqueueJob(db, "lib_a", f.v, "describe", "maker");
  }
  db.exec("UPDATE jobs SET state = 'done' WHERE kind = 'describe' AND version_id IN ('ver_1', 'ver_2', 'ver_3', 'ver_4')");
  projectId = readEdit(await create(["ver_1"]))!.projectId;
  stamp = await shotLog.stamp("ver_1"); // the library's own (shots.ts lookStamp): every file here is in one workspace
  describe6("ver_1", 60, (k) => k % 5);
  describe6("ver_2", 48, (k) => k % 5);
  describe6("ver_3", 36, (k) => k % 5);
  // the arena opens on the castle run's first picture (the same select screen); its stretch 3 is the busiest of all
  describe6("ver_4", 36, (k) => (k === 3 ? 5 : 1), (k) => (k === 0 ? ph("ver_1:0") : ph(`ver_4:${k}`)));
  shotLog.first = vi.fn();
  shotLog.redo = vi.fn(() => false);
  shotLog.retry = vi.fn();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(rootReplaced)("the gate waits, and only waits", () => {
  it("says how many files are ready with the library's own line, tells the inbox once after 30 minutes, and cuts now from what is ready", async () => {
    libraryDb().prepare("UPDATE jobs SET state = 'needs_key', error = ? WHERE version_id = 'ver_6'").run("Connect Claude on your Mac in Settings → AI.");
    const e = { id: randomUUID(), name: "Gate", createdBy: "maker", projectId, sources: ["ver_1", "ver_5", "ver_6"] };
    const err = await indexSources(e, signal, 0).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(Waiting);
    expect((err as InstanceType<typeof Waiting>).line).toBe("Waiting for the Media Library: 1 of 3 files. Connect Claude on your Mac in Settings → AI");
    expect(shotLog.first).toHaveBeenCalledWith(["ver_6"]);
    await indexSources(e, signal, STILL_WAITING_MS + 1).catch(() => {});
    await indexSources(e, signal, 2 * STILL_WAITING_MS + 1).catch(() => {});
    await vi.waitFor(() => {
      const inbox = JSON.parse(readFileSync(path.join(dir, "review", "notifications", "maker.json"), "utf8")) as { text?: string }[];
      expect(inbox.filter((n) => n.text === "Still waiting for the Media Library: 1 of 3 files")).toHaveLength(1);
    });

    const { sources, left } = await indexSources({ ...e, now: true }, signal);
    expect(sources.map((s) => s.id)).toEqual(["ver_1"]);
    expect(left).toEqual([
      { id: "ver_5", title: "Broken file", why: "the Media Library could not read it" },
      { id: "ver_6", title: "Still describing", why: "still being read by the Media Library" },
    ]);
    // the library's lines are the shots, as they are
    expect(sources[0]!.shots).toHaveLength(10);
    expect(sources[0]!.shots[1]).toEqual({ a: 6, b: 12, motion: 0.5, desc: "ver_1 stretch 1: two riders clash at the gate", action: 1, clear: false, tags: ["fight"], ph: ph("ver_1:1") });
    libraryDb().exec("UPDATE jobs SET state = 'queued', error = NULL WHERE version_id = 'ver_6'");
  });

  it("asks for lines written under another context to be written again, once, then waits", async () => {
    libraryDb().exec("UPDATE stretches SET stamp = 'older' WHERE version_id = 'ver_2'");
    const e = { id: randomUUID(), createdBy: "maker", projectId, sources: ["ver_2"] };
    await expect(indexSources(e, signal)).rejects.toBeInstanceOf(Waiting);
    expect(shotLog.redo).toHaveBeenCalledWith("ver_2", "maker");
    expect((await indexSources(e, signal)).sources.map((s) => s.id)).toEqual(["ver_2"]);
    libraryDb().prepare("UPDATE stretches SET stamp = ? WHERE version_id = 'ver_2'").run(stamp);
  });
});

describe.skipIf(rootReplaced)("the gate asks for what is missing, each once", () => {
  /** A recording the library has read, with no shot descriptions and no file here to read. */
  function recording(v: string, title: string) {
    const db = libraryDb();
    db.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, 'maker', 0)").run(`a_${v}`, title);
    db.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'maker', 0)").run(
      v, `a_${v}`, `k_${v}`, `s_${v}`, JSON.stringify({ duration: 30, width: 1920, height: 1080, fps: 30, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" }),
    );
  }
  const failJob = (v: string, kind: string, error: string) => {
    enqueueJob(libraryDb(), "lib_a", v, kind, "maker");
    libraryDb().prepare("UPDATE jobs SET state = 'failed', error = ? WHERE version_id = ? AND kind = ?").run(error, v, kind);
  };

  it("a file from before shot descriptions gets them: asked for once, waited for, then cut from", async () => {
    recording("ver_7", "From before");
    vi.mocked(shotLog.redo).mockClear().mockReturnValueOnce(true);
    const e = { id: randomUUID(), createdBy: "maker", projectId, sources: ["ver_1", "ver_7"] };
    const err = await indexSources(e, signal).catch((x: unknown) => x);
    expect((err as InstanceType<typeof Waiting>).line).toBe("Waiting for the Media Library: 1 of 2 files");
    expect(shotLog.redo).toHaveBeenCalledWith("ver_7", "maker");
    describe6("ver_7", 30, (k) => k % 5); // the library's look ran
    expect((await indexSources(e, signal)).sources.map((s) => [s.id, s.shots.length])).toEqual([["ver_1", 10], ["ver_7", 5]]);
    expect(shotLog.redo).toHaveBeenCalledTimes(1);
  });

  it("a look that failed is queued once more; failing again, the file is cut from the lines it has, and left out only with none and no file to read", async () => {
    recording("ver_8", "Look failed");
    failJob("ver_3", "look", "The AI returned no lines");
    failJob("ver_8", "look", "The AI returned no lines");
    const e = { id: randomUUID(), createdBy: "maker", projectId, sources: ["ver_3", "ver_8"] };
    await expect(indexSources(e, signal)).rejects.toBeInstanceOf(Waiting);
    expect(vi.mocked(shotLog.retry).mock.calls).toEqual([["lib_a", "ver_3", "look", "maker"], ["lib_a", "ver_8", "look", "maker"]]);
    // it failed again (the stand-in queued nothing): asked no third time
    const { sources, left } = await indexSources(e, signal);
    expect(shotLog.retry).toHaveBeenCalledTimes(2);
    expect(sources.map((s) => s.id)).toEqual(["ver_3"]);
    expect(left).toEqual([{ id: "ver_8", title: "Look failed", why: "the Media Library could not describe its shots" }]);
    libraryDb().exec("DELETE FROM jobs WHERE kind = 'look' AND version_id IN ('ver_3', 'ver_8')");
  });

  it("a look that failed for the file's size is not tried again", async () => {
    const { TOO_BIG } = await import("../library/mac-look");
    recording("ver_9", "Ten hours");
    failJob("ver_9", "look", TOO_BIG);
    vi.mocked(shotLog.retry).mockClear();
    const { sources, left } = await indexSources({ id: randomUUID(), createdBy: "maker", projectId, sources: ["ver_1", "ver_9"] }, signal);
    expect(shotLog.retry).not.toHaveBeenCalled();
    expect(sources.map((s) => s.id)).toEqual(["ver_1"]);
    expect(left.map((l) => l.id)).toEqual(["ver_9"]);
  });

  it("a file kept on a Mac with no shot descriptions is left out and named, and the cut is made from the rest; cut now asks for nothing", async () => {
    recording("ver_10", "On the Mac");
    libraryDb().exec("UPDATE asset_versions SET source_key = 'mac:dev-1:/Users/t/short.mov', mac_path = '/Users/t/short.mov' WHERE id = 'ver_10'");
    vi.mocked(shotLog.redo).mockClear();
    const e = { id: randomUUID(), createdBy: "maker", projectId, sources: ["ver_1", "ver_10"] };
    const now = await indexSources({ ...e, now: true }, signal);
    expect(shotLog.redo).not.toHaveBeenCalled();
    const { sources, left } = await indexSources(e, signal); // asked (the stand-in says it gets no look), then read
    expect(shotLog.redo).toHaveBeenCalledWith("ver_10", "maker");
    expect(sources.map((s) => s.id)).toEqual(["ver_1"]);
    expect(left).toEqual([{ id: "ver_10", title: "On the Mac", why: "it is on a computer, not uploaded, and has no shot descriptions" }]);
    expect(now.left).toEqual(left);
  });

  it("a description written under another context is written again before the file is used", async () => {
    const real = shotLog.refresh;
    shotLog.refresh = vi.fn(async (v: string) => v === "ver_4");
    const e = { id: randomUUID(), createdBy: "maker", projectId, sources: ["ver_4"] };
    await expect(indexSources(e, signal)).rejects.toBeInstanceOf(Waiting);
    expect(shotLog.refresh).toHaveBeenCalledWith("ver_4", "maker");
    shotLog.refresh = real;
    expect((await indexSources(e, signal)).sources.map((s) => s.id)).toEqual(["ver_4"]);
  });
});

describe.skipIf(rootReplaced)("a usage limit holds the step", () => {
  it("waits until the limit opens, the try not counted", async () => {
    const id = await create(["ver_1"]);
    const T = 10 ** 13;
    const until = T + 3_600_000;
    const was = STEPS.script!;
    STEPS.script = async () => {
      throw Object.assign(new MacClaudeError("Your Claude plan's 5-hour limit is reached; it resets 5pm.", "limit"), { limited: { until } });
    };
    try {
      enqueueJob(libraryDb(), "maker", `${id}:`, "script", "maker", true, "edit_jobs");
      await tick(T);
      expect(libraryDb().prepare("SELECT state, attempts, run_after, error FROM edit_jobs WHERE edit_id = ?").get(id)).toEqual({ state: "queued", attempts: 0, run_after: until, error: "Your Claude plan's 5-hour limit is reached; it resets 5pm." });
    } finally {
      STEPS.script = was;
      await call("POST", `/api/editor/${id}/stop`);
    }
    // no reset time given: 15 minutes; any other error is not a limit
    expect(limitWait(new AiProviderError("AI is rate limited — try again in a minute", "RATE_LIMIT", true), T)?.seconds).toBe(LIMIT_WAIT_S);
    expect(limitWait(new Error("wrapped", { cause: new MacClaudeError("Your Claude plan's limit is reached.", "limit") }), T)).toEqual({ seconds: LIMIT_WAIT_S, line: "Your Claude plan's limit is reached." });
    expect(limitWait(new Error("ffmpeg exited 1"), T)).toBeNull();
  });
});

describe.skipIf(rootReplaced)("the person's notes", () => {
  it("keeps a note from chat word for word and queues the next version (editor_feedback)", async () => {
    const id = await create(["ver_1"]);
    const ctx = { user: findUser("maker")!, origin: "http://test", api: (p: string, m = "GET", b?: unknown) => call(m, p, b), json: (p: string, m = "GET", b?: unknown) => json(call(m, p, b)), sure: async () => {} } as never;
    const text = "No walking around town.\n  Keep the jump, it's the best bit!";
    expect(await editorTools.handlers.editor_feedback!({ edit: id, text }, ctx)).toMatchObject({ id, kept: 1, queued: true });
    expect(readEdit(id)!.feedback).toEqual([{ at: expect.any(Number), from: "chat", by: "maker", text }]);
    expect(jobsOf(id)).toEqual([{ kind: "analyze", state: "queued" }]);
    // while it is being made: kept, and the tool says what happens to it (this run's plan, or the next version)
    expect(await editorTools.handlers.editor_feedback!({ edit: id, text: "Shorter." }, ctx)).toMatchObject({ kept: 2, queued: false, note: expect.stringContaining("else into the next version, made when this run is done") });
    // a note past the limit is refused with the reason, never cut
    const long = await call("POST", `/api/editor/${id}/feedback`, { text: "x".repeat(4001) });
    expect([long.status, (await json(long)).error]).toEqual([400, "A note is 4,000 characters at most"]);
    expect((await call("POST", `/api/editor/${id}/feedback`, { text: "y".repeat(4000) })).status).toBe(200);
    expect(readEdit(id)!.feedback!.map((n) => n.text.length)).toEqual([text.length, 8, 4000]);
    await call("POST", `/api/editor/${id}/stop`);
    // past the cap the oldest go, never the newest
    await addFeedback(id, Array.from({ length: EDIT_FEEDBACK_MAX }, (_, k) => ({ at: k, from: "chat" as const, by: "maker", text: `note ${k}` })));
    const kept = readEdit(id)!.feedback!;
    expect(kept).toHaveLength(EDIT_FEEDBACK_MAX);
    expect([kept[0]!.text, kept.at(-1)!.text]).toEqual(["note 0", `note ${EDIT_FEEDBACK_MAX - 1}`]);
  });

  it("a note sent while the edit is being made, after its script began, makes the next version when the run ends, once", async () => {
    const id = await create(["ver_1"]);
    await saveStep(id, "analysis", { sentences: [], notes: [] });
    const was = { script: STEPS.script!, draft: STEPS.draft! };
    // the scripts written, each with the notes it was given; the first is still being written when the note comes
    const given: string[][] = [];
    let sent: { queued?: boolean } = {};
    STEPS.script = async ({ edit }) => {
      given.push((edit.feedback ?? []).map((n) => n.text));
      if (given.length === 1) sent = await json(call("POST", `/api/editor/${id}/feedback`, { text: "Shorter." }));
    };
    STEPS.draft = async () => {};
    try {
      await call("POST", `/api/editor/${id}/run`, { from: "script" });
      while (await tick());
      // kept and not queued while the run went on; the run's end queued the version that reads it, and that one no other
      expect(sent.queued).toBe(false);
      expect(given).toEqual([[], ["Shorter."]]);
      expect(jobsOf(id)).toEqual([{ kind: "script", state: "done" }, { kind: "draft", state: "done" }]);
      // a note the script was given (sent before it began) makes no second version
      await call("POST", `/api/editor/${id}/feedback`, { text: "And louder." });
      while (await tick());
      expect(given).toEqual([[], ["Shorter."], ["Shorter.", "And louder."]]);
    } finally {
      Object.assign(STEPS, was);
    }
  });

  it("copies the open comments of a Changes video's newest version, each once", async () => {
    const id = await create(["ver_1"]);
    const asset = randomUUID();
    mkdirSync(path.join(dir, "review", asset), { recursive: true });
    writeFileSync(path.join(dir, "review", asset, "meta.json"), JSON.stringify({ id: asset, owner: "maker", name: "Cut", versions: [{ n: 1 }, { n: 2 }], approval: { status: "changes" } }));
    const c = (id: string, version: number, text: string, more: object = {}) => ({ id, version, text, author: "Maker", user: "maker", createdAt: Number(id.slice(1)), ...more });
    writeFileSync(
      path.join(dir, "review", asset, "comments.json"),
      JSON.stringify([c("c5", 2, "this one's dull", { t: 1.4 }), c("c6", 2, "Too long overall"), c("c7", 2, "agreed", { parentId: "c5" }), c("c8", 2, "fixed already", { t: 3, resolved: true }), c("c1", 1, "an older version's", { t: 2 })]),
    );
    await saveStep(id, "review", { v1: { assetId: asset, n: 2 } });
    emitEvent("review.changes", { asset, owner: "maker", by: "maker" });
    await vi.waitFor(() => expect(readEdit(id)!.feedback).toHaveLength(2));
    emitEvent("review.changes", { asset, owner: "maker", by: "maker" });
    await new Promise((r) => setTimeout(r, 100));
    expect(readEdit(id)!.feedback).toEqual([
      { at: 5, from: "review", variant: "v1", t: 1.4, text: "this one's dull", by: "maker" },
      { at: 6, from: "review", variant: "v1", text: "Too long overall", by: "maker" },
    ]);
  });
});

describe.skipIf(rootReplaced)("a cut from six recordings", () => {
  it("is planned from every shot line of what is ready, shows each picture once and says what was left out", async () => {
    const id = await create(FILES.map((f) => f.v));
    // "cut it now": the plan doesn't wait for the file still being described
    await call("POST", `/api/editor/${id}/run`, { from: "script", now: true });
    expect(readEdit(id)!.now).toBe(true);
    await call("POST", `/api/editor/${id}/stop`);
    const st = createStyle("maker", { name: "Hard edit" });
    if (typeof st === "string") throw new Error(st);
    change("maker", (f) => {
      f.editing.find((x) => x.id === st.id)!.learned = [
        { editId: "an-older-edit", workspaceId: readEdit(id)!.projectId ?? "", at: 1, rounds: 1, notes: [], cut: { seconds: 25, shots: 30, avgShotS: 0.83, fxPerShot: 1, sourcesUsed: 4 } },
      ];
    });
    let asked = "";
    vi.mocked(completeWithFallback).mockImplementation(async (_s, user, _sig, parse) => {
      asked = user;
      return parse(JSON.stringify({ plans: [{ kind: "hard edit", lead: "sources", shots: [{ src: "S1", in: 0, dur: 1 }, { src: "S2", in: 6, dur: 1 }, { src: "S3", in: 12, dur: 1 }, { src: "S4", in: 0, dur: 1 }] }] }));
    });
    await planStep({ edit: readEdit(id)!, job: { id: 0, actor: "maker" } as never, variant: "", signal }, []);
    expect(completeWithFallback).toHaveBeenCalledTimes(1);
    // every line of every described file, none of the others
    for (const [n, f] of FILES.slice(0, 4).entries()) for (let k = 0; k * 6 < f.dur; k++) expect(asked).toContain(`S${n + 1} ${Math.floor((k * 6) / 60)}:${String(((k * 6) % 60).toFixed(1)).padStart(4, "0")}–`);
    expect(asked).not.toContain("Broken file");
    // what was finished in the workspace rides the plan's setup (styles.ts finishedProfile, with footageProfile)
    expect(asked).toContain('Finished here: 1 "Hard edit" edit, 25 s.');
    const v1 = readStep(id, "shots")!.v1!;
    // the arena's first picture is the castle run's: the busiest stretch not shown yet takes its place
    expect(v1.plan.shots.map((s) => s.src)).toEqual([
      { source: "ver_1", inS: 0 },
      { source: "ver_2", inS: 6 },
      { source: "ver_3", inS: 12 },
      { source: "ver_4", inS: 18 },
    ]);
    expect(v1.notes).toContain("1 shot showed a picture already in the edit: the next best footage not shown yet is in its place");
    const coverage = {
      files: 6,
      minutes: 3.5,
      pooled: 4,
      pooledMinutes: 3,
      used: 4,
      left: [
        { title: "Broken file", why: "the Media Library could not read it" },
        { title: "Still describing", why: "still being read by the Media Library" },
      ],
    };
    expect(readStep(id, "plan")!.coverage).toEqual(coverage);
    expect((await json(call("GET", `/api/editor/${id}`))).coverage).toEqual(coverage);
  });
});
