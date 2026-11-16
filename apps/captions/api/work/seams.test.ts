import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Timeline } from "../../contracts/editor";
import type { WorkPackage } from "../../contracts/work";
import type { JobRow } from "../library/jobs";
import { ffmpegCommand } from "../ffmpeg-runtime";

/**
 * The seams (work/on-computer.ts): a step run on the server and the same step run through the seams on a seeded copy
 * (another data folder, no footage, its own modules) leave the same edit folder. Nothing of the AI is mocked: the
 * account's own API key answers on the server, at a local stand-in for the API; the computer's calls go to the server
 * (work/serve.ts). Module mocks are shared by both module sets (vi.resetModules keeps them), so only the eye line is one.
 */

// what the stand-in API answers: the plan to a text call, the look to a call with pictures; `queue` first, in turn
const answers = { plan: "", look: "", queue: [] as { status?: number; text: string }[], calls: 0 };
const api = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    answers.calls++;
    const next = answers.queue.shift();
    const text = next?.text ?? (body.includes('"type":"image"') ? answers.look : answers.plan);
    res.writeHead(next?.status ?? 200, { "content-type": "application/json" });
    res.end(next?.status ? JSON.stringify({ error: { type: "rate_limit_error", message: text } }) : JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

// no face model download in a test: the eye line is the same "none" on both
vi.mock("../editor/eyeline", () => ({ eyelineOf: vi.fn(async () => null) }));

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const S = mkdtempSync(path.join(scratch, "seams-server-"));
const C = mkdtempSync(path.join(scratch, "seams-computer-"));
process.env.DATA_DIR = S;
process.env.APP_SECRET = "seams-test-secret";

const load = async () => ({
  ...(await import("../ai-complete")),
  ...(await import("../my-keys")),
  ...(await import("../library/db")),
  ...(await import("../library/jobs")),
  ...(await import("../library/transcribe")),
  ...(await import("../lib/mac-claude")),
  ...(await import("../editor/analyze")),
  ...(await import("../editor/index")),
  ...(await import("../editor/preview")),
  ...(await import("../editor/script")),
  ...(await import("../editor/store")),
  ...(await import("../editor/worker")),
  ...(await import("./on-computer")),
  ...(await import("./serve")),
  ...(await import("./place")),
});
const srv = await load();

const signal = new AbortController().signal;
const T0 = Date.UTC(2026, 10, 16, 12);
const FILES = [
  { v: "ver_a", title: "Tiny Acrobatics arena", src: "testsrc" },
  { v: "ver_b", title: "Tiny Acrobatics town", src: "testsrc2" },
];
const key = (v: string) => `libraries/lib_a/v/${v}/source`;
const paths: Record<string, string> = {};

/** Every file under `dir`: path → its bytes' hash. */
function tree(dir: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const rel = path.relative(dir, path.join(e.parentPath, e.name));
    if (!skip(rel)) out[rel] = createHash("sha256").update(readFileSync(path.join(dir, rel))).digest("hex");
  }
  return out;
}

const jobOf = (editId: string, variant: string, kind: string): JobRow => {
  srv.enqueueJob(srv.libraryDb(), "lib_a", `${editId}:${variant}`, kind, "maker", true, "edit_jobs");
  return srv.libraryDb().prepare("SELECT * FROM edit_jobs WHERE version_id = ? AND kind = ? ORDER BY id DESC").get(`${editId}:${variant}`, kind) as unknown as JobRow;
};

const pkgOf = (job: JobRow, editId: string, gate?: unknown, original = false): WorkPackage => ({
  v: 1,
  job: { id: job.id, kind: job.kind, editId, variant: "", actor: job.actor!, workspaceId: "maker" },
  edit: {},
  own: [],
  rows: {},
  files: FILES.map((f) => ({ id: f.v, title: f.title, bytes: 1, ...(original ? { original: true as const } : {}) })),
  caches: {},
  ...(gate === undefined ? {} : { gate }),
  ai: { editor: null, analyzer: null },
});

/** What crosses the wire is JSON. */
const wire = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));
const asked: string[] = [];
let aiAsked = 0;
let filed: unknown[] = [];
const serverFor = (job: JobRow) => ({
  review: (r: unknown) => void filed.push(r),
  ai: async (b: unknown) => (aiAsked++, wire(await srv.serveAi(job, wire(b)))),
  call: async (fn: string, args: unknown[]) => (asked.push(fn), wire(await srv.serveCall(job, fn, wire(args)))),
  say: () => {},
});

let cmp: Awaited<ReturnType<typeof load>>;

beforeAll(async () => {
  srv.saveMyKey("maker", "ANTHROPIC_API_KEY", "sk-ant-test");
  const db = srv.libraryDb();
  db.exec("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'maker', 'A', 'local', 0)");
  for (const f of FILES) {
    const file = path.join(S, `${f.v}.mp4`);
    execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", `${f.src}=duration=4:size=320x180:rate=30`, "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
    const probe = JSON.stringify({ duration: 4, width: 320, height: 180, fps: 30, rotation: 0, format: "mov", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" });
    db.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, 'maker', 0)").run(`a_${f.v}`, f.title);
    db.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'maker', 0)").run(f.v, `a_${f.v}`, key(f.v), `s_${f.v}`, probe);
    await srv.blobs.put(key(f.v), file);
    paths[f.v] = await srv.blobs.localCopy(key(f.v));
    const words = [
      { w: "Tiny", s: 0.2, e: 0.5 },
      { w: "acrobatics", s: 0.55, e: 1.1 },
      { w: "jump.", s: 1.2, e: 1.6 },
      { w: "Again", s: 2.6, e: 3 },
    ];
    srv.saveTranscript(db, f.v, "test", "en", [{ start: 0.2, end: 3, text: words.map((w) => w.w).join(" ") }], words);
    const stamp = await srv.shotLog.stamp(f.v);
    const q = db.prepare("INSERT INTO stretches (version_id, seg, a, b, motion, action, clear, tags, text, ph, source, stamp, created_at) VALUES (?, ?, ?, ?, 0.5, 3, 1, ?, ?, ?, 'ai', ?, 0)");
    for (let k = 0; k < 2; k++) q.run(f.v, k, k * 2, k * 2 + 2, JSON.stringify(["jump"]), `${f.title}, part ${k}`, `${f.v}${k}`.padEnd(16, "0"), stamp);
  }
  srv.shotLog.first = () => {};
  srv.shotLog.redo = () => {};

  // the computer's copy: everything but the footage, its own database, then its own modules
  cpSync(S, C, { recursive: true, filter: (src) => !src.includes(`${path.sep}blobs`) && !src.endsWith(".db") && !src.endsWith(".mp4") && !/\.db-(wal|shm)$/.test(src) });
  mkdirSync(path.join(C, "library"), { recursive: true });
  db.exec(`VACUUM INTO '${path.join(C, "library", "library.db")}'`);
  process.env.DATA_DIR = C;
  process.env.CT_SEAMS_SIDE = "computer";
  vi.resetModules();
  cmp = await load();
  // a gate run on the computer would read the stamp: it never may
  cmp.shotLog.stamp = async () => {
    throw new Error("the index gate ran on the computer");
  };
  vi.useFakeTimers({ toFake: ["Date"] });
}, 60_000);

afterAll(() => {
  vi.useRealTimers();
  api.close();
  cmp?.turnOff();
  rmSync(S, { recursive: true, force: true });
  rmSync(C, { recursive: true, force: true });
});

/** Every folder the step writes: the edit's, and the editor's caches. */
const dirs = (root: string, editId: string) => ({ edit: path.join(root, "editor", editId), cache: path.join(root, "editor", "cache") });

/**
 * Runs `kind` on the server, then the same step on the computer from the server's state before it (its edit folder and
 * caches, as the package carries them), the seams on. Returns both folders after.
 */
async function both(editId: string, kind: string, variant: string, gate?: (job: JobRow) => Promise<unknown>) {
  const s = dirs(S, editId);
  const c = dirs(C, editId);
  const pre = mkdtempSync(path.join(scratch, "seams-pre-"));
  cpSync(s.edit, path.join(pre, "edit"), { recursive: true });
  if (existsSync(s.cache)) cpSync(s.cache, path.join(pre, "cache"), { recursive: true });
  const job = jobOf(editId, variant, kind);
  const pkg = { ...pkgOf(job, editId, gate ? await gate(job) : undefined), job: { ...pkgOf(job, editId).job, variant } };

  vi.setSystemTime(T0);
  await srv.STEPS[kind]!({ edit: srv.readEdit(editId)!, job, variant, signal });

  rmSync(c.edit, { recursive: true, force: true });
  rmSync(c.cache, { recursive: true, force: true });
  cpSync(path.join(pre, "edit"), c.edit, { recursive: true });
  if (existsSync(path.join(pre, "cache"))) cpSync(path.join(pre, "cache"), c.cache, { recursive: true });
  rmSync(pre, { recursive: true, force: true });
  vi.setSystemTime(T0);
  cmp.turnOn(pkg, paths, serverFor(job));
  try {
    await cmp.STEPS[kind]!({ edit: cmp.readEdit(editId)!, job, variant, signal });
  } finally {
    cmp.turnOff();
  }
  return { s, c };
}

describe("the seams: a step on a computer leaves what it leaves on the server", () => {
  it("analyze (cut around speech): the analysis and the loudness caches, footage only from the resolved paths", async () => {
    const e = (await srv.createEdit("maker", { name: "Tiny Acrobatics talk", sources: ["ver_a", "ver_b"] }))!;
    const { s, c } = await both(e.id, "analyze", "", (job) => srv.gates.analyze!({ edit: srv.readEdit(e.id)!, job, variant: "", signal }));
    expect(tree(c.edit)).toEqual(tree(s.edit));
    expect(tree(c.cache)).toEqual(tree(s.cache));
    expect(Object.keys(tree(c.cache)).filter((f) => f.endsWith(".energy.f32"))).toHaveLength(2);
    expect(JSON.parse(readFileSync(path.join(c.edit, "analysis.json"), "utf8")).sentences.length).toBeGreaterThan(0);
  }, 60_000);

  it("a planned edit's script, draft, preview and look, step by step: the same plan, draft, render and filing", async () => {
    const e = (await srv.createEdit("maker", { name: "Tiny Acrobatics hard edit", sources: ["ver_a", "ver_b"] }))!;
    await srv.saveEdit({ ...e, plan: true, brief: "A hard edit, 3 seconds", style: { id: "s1", name: "Hard edit", notes: "Cut on every beat.", pace: "tight" } as never });
    vi.setSystemTime(T0);
    await srv.STEPS.analyze!({ edit: srv.readEdit(e.id)!, job: jobOf(e.id, "", "analyze"), variant: "", signal });

    answers.plan = JSON.stringify({ plans: [{ kind: "hard edit", lead: "sources", shots: [{ src: "S1", in: 0, dur: 1 }, { src: "S2", in: 1, dur: 1 }, { src: "S1", in: 2.5, dur: 1 }] }] });
    asked.length = 0;
    aiAsked = 0;
    let r = await both(e.id, "script", "", (job) => srv.gates.script!({ edit: srv.readEdit(e.id)!, job, variant: "", signal }));
    expect(tree(r.c.edit)).toEqual(tree(r.s.edit));
    expect(tree(r.c.cache)).toEqual(tree(r.s.cache));
    expect(readFileSync(path.join(r.c.edit, "shots.json"), "utf8")).toContain('"kind":"hard edit"');
    // the workspace's context, styles and packs came from the server, as the job's account
    expect([...new Set(asked)].sort()).toEqual(["finishedProfile", "footageProfile", "packInstructions", "styleBlock", "workspaceSetup"]);
    expect(aiAsked).toBe(1);

    r = await both(e.id, "draft", "v1");
    expect(tree(r.c.edit)).toEqual(tree(r.s.edit));

    r = await both(e.id, "preview", "v1");
    // the planned cut waits for its look: rendered, not filed yet
    expect(Object.keys(tree(r.c.edit))).toContain(path.join("previews", "v1.mp4"));
    expect(tree(r.c.edit)).toEqual(tree(r.s.edit));

    answers.look = JSON.stringify({ ok: true, fails: [] });
    filed = [];
    r = await both(e.id, "critique", "v1", () => srv.gates.critique!({ edit: srv.readEdit(e.id)!, job: jobOf(e.id, "v1", "critique"), variant: "v1", signal }));
    expect(aiAsked).toBe(2); // the look, its pictures read on the server
    // the server filed it in Review; the computer left that to the server, with the thumbnail and waveform made here
    const notFiled = (rel: string) => rel === "review.json" || rel.startsWith("filed") || rel.startsWith("previews");
    expect(tree(r.c.edit, notFiled)).toEqual(tree(r.s.edit, notFiled));
    expect(existsSync(path.join(r.s.edit, "review.json"))).toBe(true);
    expect(existsSync(path.join(r.c.edit, "review.json"))).toBe(false);
    expect(filed).toHaveLength(1);
    const review = filed[0] as { thumb: string; wave: string };
    expect(review).toEqual({ variant: "v1", fails: [], thumb: path.join("editor", e.id, "previews", "v1.jpg"), wave: path.join("editor", e.id, "previews", "v1.wave.json") });
    expect(existsSync(path.join(C, review.thumb))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(C, review.wave), "utf8")).peaks.length).toBeGreaterThan(0);
  }, 240_000);
});

describe("the seams' rules", () => {
  it("gates never run with the seams on: the step takes the server's gate output, even where the gate would wait", async () => {
    const e = (await srv.createEdit("maker", { name: "Tiny Acrobatics gate", sources: ["ver_a"] }))!;
    cpSync(path.join(S, "editor", e.id), path.join(C, "editor", e.id), { recursive: true });
    // on the computer's copy the source isn't probed: its own gate would wait for the library
    cmp.libraryDb().prepare("UPDATE asset_versions SET probe = NULL, state = 'processing' WHERE id = 'ver_a'").run();
    try {
      const job = jobOf(e.id, "", "analyze");
      const gate = { planned: true, notes: ["from the server's gate"], ready: [] };
      cmp.turnOn(pkgOf(job, e.id, gate), paths, serverFor(job));
      await cmp.analyzeStep({ edit: cmp.readEdit(e.id)!, job, variant: "", signal });
      expect(cmp.readStep(e.id, "analysis")).toEqual({ sentences: [], notes: ["from the server's gate"] });
      cmp.onComputer.pkg!.gate = { ready: [], left: [{ id: "ver_a", title: "x", why: "from the server's gate" }] };
      expect(await cmp.indexSources(cmp.readEdit(e.id)!, signal)).toEqual({ sources: [], left: [{ id: "ver_a", title: "x", why: "from the server's gate" }] });
      // and with them off, the same copy's gate does wait
      cmp.turnOff();
      await expect(cmp.analyzeGate({ edit: cmp.readEdit(e.id)!, job })).rejects.toBeInstanceOf(cmp.Waiting);
    } finally {
      cmp.turnOff();
      cmp.libraryDb().prepare("UPDATE asset_versions SET probe = (SELECT probe FROM asset_versions WHERE id = 'ver_b'), state = 'ready' WHERE id = 'ver_a'").run();
    }
  });

  it("AI errors keep their class across the wire: a Mac away, a usage limit with its reopening, the API's rate limit", async () => {
    const e = (await srv.createEdit("maker", { name: "Tiny Acrobatics errors", sources: ["ver_a"] }))!;
    const job = jobOf(e.id, "", "script");
    // what serveAi sends for an error the server's chain threw (a Mac's, which this test has none to throw)
    const away = srv.aiErrorJson(new srv.MacClaudeError("No Mac took it", "unclaimed"));
    const limited = srv.aiErrorJson(new srv.AiProviderError("The AI stopped", "FAILED", false, Object.assign(new srv.MacClaudeError("Usage limit reached", "limit"), { limited: { until: T0 + 3_600_000 } })));
    const sent = [away, limited];
    cmp.turnOn(pkgOf(job, e.id), paths, { ...serverFor(job), ai: async () => wire({ error: sent.shift()! }) });
    try {
      const route = cmp.aiFor("maker", "editor", "AI Editor plan");
      expect(route).toEqual({ only: ["server"], job: "editor", mac: { label: "AI Editor plan" } });
      const a = await cmp.completeWithFallback("s", "u", signal, (t) => t, route).catch((x: unknown) => x);
      expect(a).toBeInstanceOf(cmp.MacClaudeError);
      expect(cmp.macAway(a)).toBe(a);
      const b = await cmp.completeWithFallback("s", "u", signal, (t) => t, route).catch((x: unknown) => x);
      expect(b).toBeInstanceOf(cmp.AiProviderError);
      expect((b as Error).cause).toBeInstanceOf(cmp.MacClaudeError);
      expect(cmp.limitWait(b, T0)).toMatchObject({ seconds: 3600 });

      // through the real server side: the API's 429 comes back as the same AiProviderError, a wait not a failure
      cmp.turnOn(pkgOf(job, e.id), paths, serverFor(job));
      // the server tries the API as often as its route says, as today; each one is refused
      answers.queue = Array.from({ length: 3 }, () => ({ status: 429, text: "Rate limited" }));
      const c = await cmp.completeWithFallback("s", "u", signal, (t) => t, route).catch((x: unknown) => x);
      answers.queue = [];
      expect(c).toBeInstanceOf(cmp.AiProviderError);
      expect((c as InstanceType<typeof cmp.AiProviderError>).code).toBe("RATE_LIMIT");
      expect(cmp.limitWait(c, T0)).toMatchObject({ seconds: cmp.LIMIT_WAIT_S });
      // an API answer that doesn't parse is asked again, up to the route's tries
      answers.queue = [{ text: "not json" }, { text: "{}" }];
      const before = answers.calls;
      expect(await cmp.completeWithFallback("s", "u", signal, (t) => JSON.parse(t) as unknown, { ...route, retries: 1 })).toEqual({});
      expect(answers.calls - before).toBe(2);
      // a step that has no AI for it says so without asking the server
      cmp.onComputer.pkg!.ai.editor = "No AI for your account";
      expect(cmp.aiFor("maker", "editor", "x").off).toBe("No AI for your account");
      await expect(cmp.completeWithFallback("s", "u", signal, (t) => t, cmp.aiFor("maker", "editor", "x"))).rejects.toThrow("No AI for your account");
      expect(answers.calls - before).toBe(2);
    } finally {
      answers.queue = [];
      cmp.turnOff();
    }
  });

  it("serveCall refuses unknown names and another account's edit; serveAi too", async () => {
    const e = (await srv.createEdit("maker", { name: "Tiny Acrobatics reads", sources: ["ver_a"] }))!;
    const mine = jobOf(e.id, "", "script");
    expect(typeof (await srv.serveCall(mine, "workspaceSetup", [6000]))).toBe("string");
    await expect(srv.serveCall(mine, "readFile", ["/etc/passwd"])).rejects.toBeInstanceOf(srv.Refused);
    await expect(srv.serveCall(mine, "constructor", [])).rejects.toBeInstanceOf(srv.Refused);
    await expect(srv.serveCall(mine, "packInstructions", ["workshop.write"])).rejects.toBeInstanceOf(srv.Refused);
    const theirs = { ...mine, actor: "someone-else" };
    await expect(srv.serveCall(theirs, "workspaceSetup", [6000])).rejects.toBeInstanceOf(srv.Refused);
    // the AI route sends its body as is: the refusal is an error, and no AI was asked
    const calls = answers.calls;
    expect(await srv.serveAi(theirs, { system: "s", user: "u" })).toEqual({ error: { name: "Error", message: "Not this account's edit" } });
    expect(answers.calls).toBe(calls);
    // a refused read comes back as the route's body, { error }, and the seam throws it
    cmp.turnOn(pkgOf(mine, e.id), paths, { ...serverFor(mine), call: async () => ({ error: "No such read: x" }) });
    try {
      await expect(cmp.ask("x")).rejects.toThrow("No such read: x");
    } finally {
      cmp.turnOff();
    }
  });

  it("post's files on a computer: an original already there, never a proxy in its place", async () => {
    const tl = { sources: { ver_a: { versionId: "ver_a", name: "x", fps: 30, tc: 0, dur: 120, w: 320, h: 180 } } } as unknown as Timeline;
    const job = { id: 0, actor: "maker", kind: "post", version_id: "e:v1" } as JobRow;
    cmp.turnOn(pkgOf(job, "e"), paths, serverFor(job));
    try {
      await expect(cmp.localFiles(tl)).rejects.toThrow(cmp.onlyProxy("Tiny Acrobatics arena"));
      expect(await cmp.localFiles(tl, undefined, true)).toEqual({ ver_a: paths.ver_a });
      cmp.turnOn(pkgOf(job, "e", undefined, true), paths, serverFor(job));
      expect(await cmp.localFiles(tl)).toEqual({ ver_a: paths.ver_a });
    } finally {
      cmp.turnOff();
    }
  });
});
