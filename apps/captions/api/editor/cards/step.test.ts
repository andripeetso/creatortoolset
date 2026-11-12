import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CARDS_DRAW_KIND, EDITOR_HINT, type CardsDraw } from "../../../contracts/devices";
import type { Edit, Sentence, Timeline } from "../../../contracts/editor";
import type { AnimationStyle, EditingStyle } from "../../../contracts/editor-styles";
import { ffmpegCommand } from "../../ffmpeg-runtime";

// The card step from end to end, on the real routes: the person's AI is their own Anthropic key (the requests are
// caught where they leave the server, so each one is counted and read), and the Mac is a stand-in that speaks the
// device contract: it asks for nothing on a clock; its long poll lists the kind it draws, and it claims only when the
// poll is answered with the hint (then: read the cards, send a clip and three stills a card, done or fail).

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-cards-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-cards-test-secret";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_BASE_URL;

const { createUser, setOff } = await import("../../users");
const app = (await import("../../boot")).default;
// A loaded plug-in that replaces /api/editor answers the root itself, so these tests (which drive the built-in root) run only without one.
const rootReplaced = (await import("../../lib/plugin")).pluginReplaces("/api/editor");
const { pairDevice, devicesSaved, deviceOf } = await import("../../lib/devices");
const { streamMacClaude } = await import("../../lib/mac-claude");
const { blobs, libraryDb } = await import("../../library/db");
const { enqueueJob } = await import("../../library/jobs");
const { saveMyKey } = await import("../../my-keys");
const { addPicture, animationStyles } = await import("../animation-styles");
const { change } = await import("../styles");
const { mediaPaths } = await import("../media");
const { runSteps } = await import("../post");
const voice = (await import("../../../editor-steps/voice/plugin")).default.editor!.steps![0]!;
const { faceRanges } = await import("../../../editor-steps/face-refine/plugin");
const { localFiles, renderPreview } = await import("../preview");
const { editDir, readDraft, readEdit, saveDraft, saveStep } = await import("../store");
const { emptyTracks } = await import("../timeline");
const { tick } = await import("../worker");
const { CARD_TEXT_MAX, ERROR_MAX, MAX_CALLS, MAX_CARDS, MAX_DRAWS, SCRIPT_MAX, readCards } = await import("./state");
const { cardWindow, placeCards } = await import("./place");
const { fixPrompt, parsePlan, parseScript } = await import("./prompts");
const { scriptThrew } = await import("./device");
const { clock, LOOK_PICTURES, MAKE_PICTURES, SHEET_MAX_BYTES, SHEET_MAX_SIDE } = await import("./step");

const cookies: Record<string, string> = {};
async function login(username: string) {
  setOff(createUser(username, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie: cookies[user]!, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const ffprobe = (file: string, ...args: string[]) => execFileSync(ffmpegCommand().replace(/ffmpeg$/, "ffprobe"), ["-v", "error", ...args, file], { encoding: "utf8" }).trim();
/** One grey frame of `file` as raw bytes. */
const frame = (file: string, n: number) => execFileSync(ffmpegCommand(), ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
/** One colour all over (a card clip here is), which a picture of the take never is. */
const uniform = (b: Buffer) => new Set(b).size <= 3;

/* ---- the person's AI: the requests that leave for the Anthropic API, each answered from a list ---- */

interface Asked {
  system: string;
  text: string;
  images: string[];
  keys: string[];
}
let asked: Asked[] = [];
/** What the AI answers, in order; a function is called when its request arrives (a test stops the edit there). */
let answers: (string | (() => Promise<string>))[] = [];
beforeEach(() => {
  asked = [];
  answers = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    if (!String(url).endsWith("/v1/messages")) throw new Error(`An unexpected request left the server: ${String(url)}`);
    const body = JSON.parse(init!.body as string) as { system: string; messages: { content: string | { type: string; text?: string; source?: { data: string } }[] }[] };
    const content = body.messages[0]!.content;
    asked.push({
      system: body.system,
      text: typeof content === "string" ? content : content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
      images: typeof content === "string" ? [] : content.filter((c) => c.type === "image").map((c) => c.source!.data),
      keys: Object.keys(body).sort(),
    });
    const next = answers.shift();
    if (next === undefined) throw new Error("The step asked the AI one time more than this test allows");
    const text = typeof next === "function" ? await next() : next;
    return new Response(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  clock.now = () => Date.now();
});

const SCRIPT = `function kitFrame(t, card) { const s = document.getElementById("stage"); s.style.background = "#c00"; s.textContent = card.text; }`;
const PLAN = JSON.stringify({ cards: [{ line: 2, text: "Tuck your chin" }, { line: 3, text: "Push with both hands" }] });

/* ---- the Mac: a stand-in that speaks the device contract ---- */

let mac: { device: { id: string }; token: string };
let other: { device: { id: string }; token: string };
const relay = (token: string, method: string, url: string, body?: string | FormData, type = "application/json") =>
  app.request(`/api/devices/relay/editor${url}`, { method, headers: { authorization: `Bearer ${token}`, ...(type ? { "content-type": type } : {}) }, ...(body === undefined ? {} : { body }) });
/** The Mac's long poll, as it sends it while it could draw: the kinds it would claim right now ride along. */
const LISTS = { blobs: true, editor: [CARDS_DRAW_KIND] };
const poll = (token = mac.token, body: object = LISTS) =>
  (due(), app.request("/api/devices/relay/wait", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
/** A poll nothing answers is held 25 seconds and ends empty (204), as it always has. The test's clock runs those seconds. */
async function held(token = mac.token, body: object = LISTS): Promise<number> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let status: number | undefined;
    void Promise.resolve(poll(token, body)).then((r) => (status = r.status));
    for (let i = 0; i < 300 && status === undefined; i++) {
      await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(1000);
    }
    return status ?? 0;
  } finally {
    vi.useRealTimers();
  }
}
/** The claim. A Mac posts it only after a hint; the tests also use it to see that nothing is left to take. */
const claim = (token = mac.token) => (due(), json<{ job: { id: number; kind: string; editId: string; variant: string } | null }>(relay(token, "POST", "/claim", JSON.stringify({ kinds: [CARDS_DRAW_KIND] }))));
const red = path.join(dir, "red.png");
/** A card's upload, as the Mac sends it: `clip`, then `still` three times. */
function cardForm(seconds: number, colour = "red"): FormData {
  const clip = path.join(dir, `card-${colour}-${seconds}.mp4`);
  if (!existsSync(clip)) execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=360x640:r=30:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
  const form = new FormData();
  form.append("clip", new File([readFileSync(clip)], "card.mp4", { type: "video/mp4" }));
  for (const name of ["first", "middle", "last"]) form.append("still", new File([readFileSync(red)], `${name}.png`, { type: "image/png" }));
  return form;
}
/** Plays the Mac for one draw: its poll is told a step waits, it takes the step, reads the cards, sends each one (but `skip`), then done, or fail with `fail`. */
async function drawOnMac(o: { fail?: string; skip?: string[]; colour?: string } = {}): Promise<CardsDraw> {
  const told = await poll();
  expect([told.status, await told.json()]).toEqual([200, EDITOR_HINT]);
  const { job } = await claim();
  expect(job).toMatchObject({ kind: CARDS_DRAW_KIND });
  if (!job) throw new Error("The hint led to no step");
  const sheet = await json<CardsDraw>(relay(mac.token, "GET", `/job/${job.id}/cards`, undefined, ""));
  for (const c of sheet.cards) {
    if (o.skip?.includes(c.id)) continue;
    const sent = await relay(mac.token, "POST", `/job/${job.id}/cards/${c.id}`, cardForm(c.seconds, o.colour), "");
    expect(sent.status).toBe(200);
  }
  expect(await json(relay(mac.token, "POST", `/job/${job.id}/${o.fail ? "fail" : "done"}`, JSON.stringify(o.fail ? { error: o.fail } : {})))).toMatchObject({ ok: true });
  return sheet;
}

/* ---- the edit: four lines, 30 frames a second ---- */

const sentences: Sentence[] = ["Here is the thing about rolling.", "First, tuck your chin all the way.", "Then push with both hands.", "Follow for the next one."].map((text, k) => ({
  n: k + 1, src: "ver_a", text, s: k * 3, e: k * 3 + 2.8, w0: 0, w1: 4,
}));
const lines = sentences.map((s) => ({ id: `L${s.n}`, text: s.text, takes: [{ first: s.n, last: s.n, score: 0.9 }] }));
const plan = (ids = lines.map((l) => l.id)) => ({ lines, plans: [{ name: "v1", title: "Version 1", lines: ids.map((id) => ({ line: id, take: lines.find((l) => l.id === id)!.takes[0]! })) }], notes: [] });
/** Shots of 3, 4, 2 and 3 seconds, one a line, with two B-roll cutaways: one over the first line, one where the second line's card will go. */
function timeline(order = ["L1", "L2", "L3", "L4"]): Timeline {
  const len: Record<string, number> = { L1: 90, L2: 120, L3: 60, L4: 90 };
  const t: Timeline = {
    name: "Rolling v1", fps: 30, width: 360, height: 640,
    sources: { ver_a: { versionId: "ver_a", name: "Take", fps: 30, tc: 0, dur: 360, w: 360, h: 640 }, ver_b: { versionId: "ver_b", name: "Cover", fps: 30, tc: 0, dur: 360, w: 360, h: 640 } },
    tracks: emptyTracks(),
    markers: [],
  };
  let rec = 0;
  for (const [k, id] of order.entries()) {
    t.tracks.V1.items.push({ src: "ver_a", in: k * 90, len: len[id]!, rec, link: `c${k + 1}` });
    t.tracks.A1.items.push({ src: "ver_a", in: k * 90, len: len[id]!, rec, link: `c${k + 1}` });
    t.markers.push({ rec, name: id, color: "BLUE", note: "" });
    rec += len[id]!;
  }
  if (order[0] === "L1") t.tracks.V2.items = [{ src: "ver_b", in: 0, len: 40, rec: 46 }, { src: "ver_b", in: 60, len: 40, rec: 150 }];
  return t;
}

let anim: AnimationStyle;
let style: EditingStyle;
const jobs = (editId: string) => libraryDb().prepare("SELECT kind, state, error FROM edit_jobs WHERE edit_id = ? ORDER BY id").all(editId) as { kind: string; state: string; error: string | null }[];
const jobOf = (editId: string, kind: string) => jobs(editId).find((j) => j.kind === kind);
/**
 * The server's worker, one step: a step that waits (a card step with its draw out looks again in 10 seconds) is due
 * now, and so are a later step's waits. The time itself stays the real one, as a Mac's lease runs on it.
 */
const due = () => void libraryDb().prepare("UPDATE edit_jobs SET run_after = 0 WHERE state = 'queued'").run();
const step = () => (due(), tick());
/** Runs the worker until nothing of the edit is queued or running. */
async function drain(id: string) {
  for (let i = 0; i < 400 && jobs(id).some((j) => j.state === "queued" || j.state === "running"); i++) {
    await step();
    await new Promise((r) => setTimeout(r, 50));
  }
}
/** The worker has one queue for every edit: what other edits of these tests left waiting is stopped, so the next step is this edit's. */
const only = (id: string) => void libraryDb().prepare("UPDATE edit_jobs SET state = 'failed', lease_until = NULL, error = 'Stopped' WHERE edit_id != ? AND state IN ('queued', 'running')").run(id);
/** A new edit with a draft, its B-roll step queued: what the chain has when the cards' turn comes. */
async function newEdit(user = "maker", withStyle: string | null = style.id): Promise<string> {
  const { id } = await json<{ id: string }>(call(user, "POST", "/api/editor", { name: "Rolling", sources: ["ver_a"], ...(withStyle ? { style: withStyle } : {}) }));
  await saveStep(id, "analysis", { sentences, notes: [] });
  await saveStep(id, "plan", plan());
  await saveDraft(id, "v1", { timeline: timeline(), notes: [] });
  enqueueJob(libraryDb(), user, `${id}:v1`, "broll", user, true, "edit_jobs");
  return id;
}
/** Runs the B-roll step and the cards step's first wake. */
async function toCards(id: string) {
  only(id);
  await step();
  expect(jobOf(id, "broll")).toMatchObject({ state: "done" });
  await step();
}
const cardsOnCut = (id: string) => readDraft(id, "v1")!.timeline.tracks.V2.items.filter((i) => i.src.startsWith("card-"));
const view = (id: string, user = "maker") => json<Edit>(call(user, "GET", `/api/editor/${id}`));

beforeAll(async () => {
  for (const u of ["maker", "nomac", "other"]) await login(u);
  for (const u of ["maker", "nomac"]) saveMyKey(u, "ANTHROPIC_API_KEY", "test-key-of-the-account");
  const take = path.join(dir, "take.mp4");
  const cover = path.join(dir, "cover.mp4");
  execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=12:size=360x640:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", take]);
  execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=duration=12:size=360x640:rate=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", cover]);
  execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=540x960", "-frames:v", "1", red]);
  const d = libraryDb();
  for (const u of ["maker", "nomac"]) {
    const ids = u === "maker" ? ["a", "b"] : ["n"];
    d.exec(`INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_${u}', '${u}', 'A', 'local', 0);`);
    for (const k of ids) {
      d.exec(`
        INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_${k}', 'lib_${u}', 'video', 'Take ${k}', '${u}', 0);
        INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at)
          VALUES ('ver_${k}', 'ast_${k}', 1, 'libraries/lib_${u}/v/ver_${k}/source', 1, 'sha-${k}', 'video/mp4', 'ready', '${u}', 0);
      `);
      const copy = path.join(dir, `copy-${k}.mp4`);
      execFileSync("cp", [k === "b" ? cover : take, copy]);
      await blobs.put(`libraries/lib_${u}/v/ver_${k}/source`, copy);
    }
  }
  mac = pairDevice("maker", "Studio Mac");
  other = pairDevice("other", "Other Mac");
  anim = await json<AnimationStyle>(call("maker", "POST", "/api/editor/animation-styles", { name: "Bold red", brief: "Big white words on deep red. Nothing bounces." }));
  style = await json<EditingStyle>(call("maker", "POST", "/api/editor/styles", { name: "With cards", animation: anim.id }));
  // the Mac is on: its first long poll lists the kind it draws. Nothing waits, so the poll is held and ends empty.
  expect(deviceOf(mac.device.id)?.kinds ?? []).toEqual([]);
  expect(await held()).toBe(204);
  expect(deviceOf(mac.device.id)?.kinds).toEqual([CARDS_DRAW_KIND]);
}, 120_000);
afterAll(async () => {
  await devicesSaved();
  await new Promise((r) => setTimeout(r, 300)); // an answer's usage is written after it: let the last one land before its folder goes
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(rootReplaced)("an edit with no animation style", () => {
  it("gets the job rows and the cut it always got: no cards step, no card file, the draft untouched, no AI call", async () => {
    const plain = await json<EditingStyle>(call("maker", "POST", "/api/editor/styles", { name: "Plain" }));
    for (const withStyle of [null, plain.id]) {
      const id = await newEdit("maker", withStyle);
      const before = readFileSync(path.join(editDir(id), "drafts", "v1.json"), "utf8");
      only(id);
      await drain(id);
      expect(jobs(id)).toEqual(["broll", "post", "preview", "file"].map((kind) => ({ kind, state: "done", error: null })));
      expect(readFileSync(path.join(editDir(id), "drafts", "v1.json"), "utf8")).toBe(before);
      expect(readdirSync(path.join(editDir(id), "drafts"))).toEqual(["v1.json"]); // never saved again
      expect(existsSync(path.join(editDir(id), "cards"))).toBe(false);
      expect(await view(id)).not.toHaveProperty("cards");
    }
    expect(asked).toEqual([]);
    expect(await claim()).toEqual({ job: null });
  }, 120_000);
});

describe.skipIf(rootReplaced)("the card step", () => {
  let id: string;

  it("plans, makes, has the Mac draw, looks once, and lays the cards where the plan put them", async () => {
    id = await newEdit();
    answers = [PLAN, "```js\n" + SCRIPT + "\n```", "OK"];
    await toCards(id);

    // 1. the plan: the lines as spoken, the ones a card fits over marked, the brief in the person's words
    // 2. the make call: no picture in the style yet, so it is asked in words alone
    expect(asked).toHaveLength(2);
    expect(asked[0]!.text).toBe(
      "The look, in the author's own words:\nBig white words on deep red. Nothing bounces.\n\nThe lines (a line marked * can carry a card):\n1* Here is the thing about rolling.\n2* First, tuck your chin all the way.\n3* Then push with both hands.\n4 Follow for the next one.",
    );
    expect(asked[1]!.images).toEqual([]);
    expect(asked[1]!.text).toContain('c1 (2.4 s): "Tuck your chin" over the line "First, tuck your chin all the way."');
    expect(asked[1]!.text).toContain('c2 (1.2 s): "Push with both hands" over the line "Then push with both hands."');
    expect(asked[1]!.text).toContain("The frame: 360 by 640 pixels, 30 frames a second.");
    expect(asked[1]!.system).toContain("kitFrame(t, card)");

    // 3. the draw: a step only a Mac of the account takes; the cards step waits for it
    expect(jobs(id).slice(1)).toEqual([{ kind: "cards", state: "queued", error: null }, { kind: CARDS_DRAW_KIND, state: "queued", error: null }]);
    expect((await claim(other.token)).job).toBeNull();
    const sheet = await drawOnMac();
    expect(sheet).toEqual({
      width: 360, height: 640, fps: 30, script: SCRIPT,
      cards: [
        { id: "c1", seconds: 2.4, content: { id: "c1", text: "Tuck your chin", line: "First, tuck your chin all the way." } },
        { id: "c2", seconds: 1.2, content: { id: "c2", text: "Push with both hands", line: "Then push with both hands." } },
      ],
    });

    // 4. the look: one sheet of the stills, the script, and the answer OK; then the cards go on the cut
    await step();
    expect(asked).toHaveLength(3);
    expect(asked[2]!.images).toHaveLength(1);
    expect(asked[2]!.text).toContain("The first picture is the sheet: one card in each column");
    expect(asked[2]!.text.endsWith(`The script:\n${SCRIPT}`)).toBe(true);
    // each of the three is a question and nothing more (answer-only.test.ts has every route)
    for (const a of asked) expect(a.keys).toEqual(["max_tokens", "messages", "model", "output_config", "system"]);
    // the installed packs' card text (the app's own basics pack is one) is in the plan, as the script step has its own, and in no other call
    const packs = "Instructions from packs the author installed for the animated cards.";
    expect(asked[0]!.system).toContain(packs);
    expect(asked[0]!.system).toContain("One idea per card");
    for (const a of asked.slice(1)) expect(`${a.system}\n${a.text}`).not.toContain("Instructions from packs");
    expect(jobOf(id, "cards")).toMatchObject({ state: "done" });
    expect(jobOf(id, CARDS_DRAW_KIND)).toBeUndefined();
    expect(jobOf(id, "post")).toMatchObject({ state: "queued" }); // and the chain goes on as it does after the B-roll

    // 5. where: over its line's first shot, ending on his cut; the cutaway that lay there is gone, the other stays
    const tl = readDraft(id, "v1")!.timeline;
    expect(tl.tracks.V2.items).toEqual([
      { src: "ver_b", in: 0, len: 40, rec: 46 },
      { src: "card-c1", in: 0, len: 72, rec: 138 },
      { src: "card-c2", in: 0, len: 36, rec: 234 },
    ]);
    expect(tl.sources["card-c1"]).toEqual({ versionId: "card-c1", name: "Card 1", fps: 30, tc: 0, dur: 72, w: 360, h: 640, file: "cards/v1/c1.mp4" });
    expect(tl.tracks.V1.items).toEqual(timeline().tracks.V1.items); // his own track is not touched
    expect(readCards(id, "v1")).toMatchObject({ calls: 3, draws: 1, drawn: ["c1", "c2"], done: true });
    expect((await view(id)).cards).toEqual({ v1: { cards: [{ id: "c1", text: "Tuck your chin", liked: false }, { id: "c2", text: "Push with both hands", liked: false }] } });

    // the preview shows the card there and his take everywhere else, and his voice runs on under it
    const out = path.join(dir, "with-cards.mp4");
    await renderPreview(tl, await localFiles(tl, id), out);
    expect(Number(ffprobe(out, "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"))).toBe(360);
    expect([137, 138, 209, 210, 233, 234, 269, 270].map((n) => uniform(frame(out, n)))).toEqual([false, true, true, false, false, true, true, false]);
    expect(Number(ffprobe(out, "-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "csv=p=0"))).toBeCloseTo(12, 0);
  }, 120_000);

  it("a post-processing step gets a cut with cards and leaves the cards alone", async () => {
    const tl = readDraft(id, "v1")!.timeline;
    // what the post step hands every step: the footage's files (a card is the edit's own clip, and not footage)
    const base = await localFiles(tl);
    expect(Object.keys(base).sort()).toEqual(["ver_a", "ver_b"]);
    const out = await runSteps([{ id: "voice", values: { noise: "light" } }], [voice], { edit: { id, name: "Rolling", createdBy: "maker" }, variant: "v1", timeline: tl, base, workRoot: path.join(dir, "post"), signal: new AbortController().signal });
    expect(Object.keys(out.files)).toEqual(["ver_a"]); // his voice, cleaned; nothing made of a card
    expect(out.notes).toEqual([]);
    // face refinement works on his picture where the cut shows it: not under a card, and never on a card's clip
    expect(Object.keys(faceRanges(tl))).toEqual(["ver_a"]);
  }, 60_000);

  it("the rest of the chain takes a cut with cards: post-processing, the preview and its filing all finish", async () => {
    await drain(id);
    expect(jobs(id)).toEqual(["broll", "cards", "post", "preview", "file"].map((kind) => ({ kind, state: "done", error: null })));
    expect((await view(id)).previews.v1).toBeDefined();
  }, 120_000);

  it("the script is the edit's own file and goes to the Mac alone: no answer to a signed-in page carries it", async () => {
    expect(readFileSync(path.join(editDir(id), "cards", "v1", "script.txt"), "utf8")).toBe(SCRIPT);
    for (const url of [`/api/editor/${id}`, `/api/editor/${id}/drafts/v1`, `/api/editor/${id}/sentences`, `/api/editor/${id}/drafts/v1/export?format=otio`, `/api/editor/${id}/drafts/v1/export?format=fcpxml`, `/api/editor/${id}/drafts/v1/export`, `/api/editor/${id}/cards/v1/c1/still`, "/api/editor", "/api/editor/animation-styles"]) {
      const got = await call("maker", "GET", url);
      expect(got.status, url).toBe(200);
      expect(Buffer.from(await got.arrayBuffer()).toString("latin1"), url).not.toContain("kitFrame");
    }
    for (const url of [`/api/editor/${id}/cards/v1/script`, `/api/editor/${id}/cards/v1/script.txt`, `/api/editor/${id}/cards/v1`]) expect((await call("maker", "GET", url)).status).toBe(404);
  });

  it("the export names the card's clip: a path in the edit's folder, and inside the zip", async () => {
    const otio = await call("maker", "GET", `/api/editor/${id}/drafts/v1/export?format=otio`);
    expect(otio.status).toBe(200);
    const text = JSON.stringify(await otio.json());
    expect(text).toContain(JSON.stringify(path.join(editDir(id), "cards", "v1", "c1.mp4")).slice(1, -1));
    // the B-roll clip has a path too: it is not one of the edit's own sources, and an export with B-roll failed before
    expect(text).toContain("Take b.mp4");
    // the zip carries the clips themselves, and its timelines name them beside the timeline
    const zip = Buffer.from(await (await call("maker", "GET", `/api/editor/${id}/drafts/v1/export`)).arrayBuffer()).toString("latin1");
    for (const f of ["Rolling v1/Rolling v1.otio", "Rolling v1/media/card-c1.mp4", "Rolling v1/media/card-c2.mp4"]) expect(zip).toContain(f);
    const tl = readDraft(id, "v1")!.timeline;
    const m = await mediaPaths(readEdit(id)!, Object.keys(tl.sources), tl.sources, true);
    expect(m.files["card-c1"]).toBe("media/card-c1.mp4");
    expect(m.own.map((o) => o.name)).toEqual(["card-c1.mp4", "card-c2.mp4"]);
  });

  it("a version cut again places its cards where the lines are now, with no AI call and no draw", async () => {
    // the script table moved line 3 before line 2 and dropped the cutaways: a new draft, then the chain's B-roll and cards
    await saveStep(id, "plan", plan(["L1", "L3", "L2", "L4"]));
    await saveDraft(id, "v1", { timeline: timeline(["L1", "L3", "L2", "L4"]), notes: [] });
    enqueueJob(libraryDb(), "maker", `${id}:v1`, "broll", "maker", true, "edit_jobs");
    await toCards(id);
    expect(asked).toEqual([]);
    expect(await claim()).toEqual({ job: null });
    expect(jobOf(id, "cards")).toMatchObject({ state: "done" });
    // line 3 is now at 90..150, line 2 at 150..270
    expect(cardsOnCut(id)).toEqual([{ src: "card-c2", in: 0, len: 36, rec: 114 }, { src: "card-c1", in: 0, len: 72, rec: 198 }]);
    expect(readCards(id, "v1")).toMatchObject({ calls: 3, draws: 1 });

    // a cut that no longer has line 2 leaves its card off, and says so
    await saveStep(id, "plan", plan(["L1", "L3", "L4"]));
    await saveDraft(id, "v1", { timeline: timeline(["L1", "L3", "L4"]), notes: [] });
    enqueueJob(libraryDb(), "maker", `${id}:v1`, "broll", "maker", true, "edit_jobs");
    await toCards(id);
    expect(cardsOnCut(id).map((i) => i.src)).toEqual(["card-c2"]);
    expect((await view(id)).cards!.v1!.note).toBe("Cards: no room for “Tuck your chin” in this cut");
    expect(asked).toEqual([]);
    await call("maker", "POST", `/api/editor/${id}/stop`);
  });

  it("👍 puts the card's still in the style's Made & liked, once, and only its maker can", async () => {
    const still = await call("maker", "GET", `/api/editor/${id}/cards/v1/c2/still`);
    expect(still.headers.get("content-type")).toBe("image/png");
    expect((await call("other", "GET", `/api/editor/${id}/cards/v1/c2/still`)).status).toBe(404);
    expect((await call("other", "POST", `/api/editor/${id}/cards/v1/c2/like`)).status).toBe(404);
    expect((await call("maker", "POST", `/api/editor/${id}/cards/v1/c9/like`)).status).toBe(404);
    expect(animationStyles("maker")[0]!.pictures).toEqual([]);

    const liked = await json<Edit>(call("maker", "POST", `/api/editor/${id}/cards/v1/c2/like`));
    expect(liked.cards!.v1!.cards.map((c) => [c.id, c.liked])).toEqual([["c1", false], ["c2", true]]);
    await call("maker", "POST", `/api/editor/${id}/cards/v1/c2/like`);
    const pictures = animationStyles("maker")[0]!.pictures;
    expect(pictures.map((p) => p.kind)).toEqual(["made"]);
    // and the next edit's make call is shown it
    const next = await newEdit();
    answers = [PLAN, SCRIPT];
    await toCards(next);
    expect(asked[1]!.images).toHaveLength(1);
    expect(asked[1]!.text).toContain("Picture 1: stills of cards the author liked in earlier videos. They show the look, not the words.");
    await call("maker", "POST", `/api/editor/${next}/stop`);
  });

  it("Make cards again clears them and makes them from nothing: three calls and a draw more", async () => {
    await saveStep(id, "plan", plan());
    await saveDraft(id, "v1", { timeline: timeline(), notes: [] });
    expect((await call("other", "POST", `/api/editor/${id}/cards/v1/again`)).status).toBe(404);
    expect((await call("maker", "POST", `/api/editor/${id}/cards/v1/again`)).status).toBe(200);
    expect(readCards(id, "v1")).toBeNull();
    expect(existsSync(path.join(editDir(id), "cards", "v1"))).toBe(false);
    expect((await call("maker", "POST", `/api/editor/${id}/cards/v1/again`)).status).toBe(409); // it is being made
    answers = [PLAN, SCRIPT, "OK"];
    await toCards(id);
    await drawOnMac();
    await step();
    expect(asked).toHaveLength(3);
    expect(cardsOnCut(id).map((i) => i.rec)).toEqual([138, 234]);
    expect(readCards(id, "v1")).toMatchObject({ calls: 3, draws: 1, liked: [] });
    await call("maker", "POST", `/api/editor/${id}/stop`);
  });

  it("a look that corrects the script has it drawn once more, and never a third time", async () => {
    const e = await newEdit();
    const fixed = `${SCRIPT}\n// bigger words`;
    answers = [PLAN, SCRIPT, fixed];
    await toCards(e);
    expect((await drawOnMac()).script).toBe(SCRIPT);
    await step(); // the look: a corrected script, so a second draw is asked for
    expect(jobOf(e, "cards")).toMatchObject({ state: "queued" });
    expect((await drawOnMac({ colour: "blue" })).script).toBe(fixed);
    await step(); // the second draw is in: no second look
    expect(asked).toHaveLength(3);
    expect(readCards(e, "v1")).toMatchObject({ calls: 3, draws: 2, done: true });
    expect(await claim()).toEqual({ job: null });
    // the clips on the cut are the second draw's
    expect(readFileSync(path.join(editDir(e), "cards", "v1", "c1.mp4")).equals(readFileSync(path.join(dir, "card-blue-2.4.mp4")))).toBe(true);
    expect(cardsOnCut(e)).toHaveLength(2);
  });

  it("a corrected script that is not drawn leaves the first draw's cards on the cut", async () => {
    const e = await newEdit();
    answers = [PLAN, SCRIPT, `${SCRIPT}\n// other`];
    await toCards(e);
    await drawOnMac();
    await step();
    for (let attempt = 1; attempt <= 3; attempt++) await drawOnMac({ fail: "Card 1 of 2 drew nothing.", skip: ["c1"], colour: "blue" });
    await step();
    expect(cardsOnCut(e)).toHaveLength(2);
    expect(readFileSync(path.join(editDir(e), "cards", "v1", "c2.mp4")).equals(readFileSync(path.join(dir, "card-red-1.2.mp4")))).toBe(true);
    expect((await view(e)).cards!.v1!.note).toBe("Cards: the corrected cards were not drawn (Card 1 of 2 drew nothing.)");
  });
});

describe.skipIf(rootReplaced)("a script that throws on the Mac", () => {
  // the Mac's own words for it (CardJobs.swift cardFailure), as a real run had them
  const THREW = "Card 1 of 2 has a script that failed (TypeError: null is not an object (evaluating 'canvas.getContext')). Card 2 of 2 has a script that failed (TypeError: null is not an object (evaluating 'canvas.getContext')).";
  const BROKEN = `const canvas = document.querySelector("canvas");\nfunction kitFrame(t, card) { canvas.getContext("2d"); }`;
  const FIXED = `function kitFrame(t, card) { const s = document.getElementById("stage"); s.style.background = "#00c"; s.textContent = card.text; }`;
  /** The Mac draws the script and every card throws: it sends no card and fails the step in its words. */
  const throws = () => drawOnMac({ fail: THREW, skip: ["c1", "c2"] });

  it("is not drawn again: one fix call carries the Mac's words, the fix is drawn once, the cards go on, and the look comes after", async () => {
    const e = await newEdit();
    answers = [PLAN, BROKEN, FIXED, "OK"];
    await toCards(e);
    expect((await throws()).script).toBe(BROKEN);
    // at once: no try again for a Mac to take, even with the queue's wait over
    expect(jobOf(e, CARDS_DRAW_KIND)).toEqual({ kind: CARDS_DRAW_KIND, state: "failed", error: THREW });
    expect(await claim()).toEqual({ job: null });

    await step(); // the fix: words alone, the make call's stage and frame, the script and the Mac's sentence
    expect(asked).toHaveLength(3);
    const fix = asked[2]!;
    expect(fix.images).toEqual([]);
    expect(fix.keys).toEqual(["max_tokens", "messages", "model", "output_config", "system"]);
    expect(fix.system).toContain("The script threw an error on the Mac that draws them");
    expect(fix.system).toContain('the id "stage", a <div> (not a canvas');
    expect(fix.system).toContain("Answer with the script only");
    expect(fix.text).toContain("The look, in the author's own words:\nBig white words on deep red. Nothing bounces.");
    expect(fix.text).toContain('c1 (2.4 s): "Tuck your chin" over the line "First, tuck your chin all the way."');
    expect(fix.text.endsWith(`The script:\n${BROKEN}\n\nWhat the Mac said:\n${THREW}`)).toBe(true);
    expect(`${fix.system}\n${fix.text}`).not.toContain("Instructions from packs");

    expect((await drawOnMac({ colour: "blue" })).script).toBe(FIXED);
    await step(); // the look, once, on the fixed cards
    expect(asked).toHaveLength(4);
    expect(asked[3]!.text).toContain("The first picture is the sheet");
    expect(asked[3]!.text.endsWith(`The script:\n${FIXED}`)).toBe(true);
    expect(jobOf(e, "cards")).toMatchObject({ state: "done" });
    expect(jobOf(e, CARDS_DRAW_KIND)).toBeUndefined();
    expect(jobOf(e, "post")).toMatchObject({ state: "queued" });
    expect(cardsOnCut(e).map((i) => i.src)).toEqual(["card-c1", "card-c2"]);
    expect(readFileSync(path.join(editDir(e), "cards", "v1", "c1.mp4")).equals(readFileSync(path.join(dir, "card-blue-2.4.mp4")))).toBe(true);
    expect(readCards(e, "v1")).toMatchObject({ calls: 4, draws: 2, fixed: true, done: true });
    expect(readCards(e, "v1")).not.toHaveProperty("note");
    expect((await view(e)).cards!.v1!.cards).toHaveLength(2);
    await call("maker", "POST", `/api/editor/${e}/stop`);
  });

  it("a fix that throws too: no cards, the Mac's words as the note, and no third draw", async () => {
    const e = await newEdit();
    answers = [PLAN, BROKEN, FIXED];
    await toCards(e);
    await throws();
    await step();
    expect((await throws()).script).toBe(FIXED);
    expect(await claim()).toEqual({ job: null });
    await step();
    expect(asked).toHaveLength(3); // no look at a draw that failed, and no second fix
    expect(await claim()).toEqual({ job: null });
    expect(jobOf(e, CARDS_DRAW_KIND)).toBeUndefined();
    expect(jobOf(e, "cards")).toMatchObject({ state: "done" });
    expect(jobOf(e, "post")).toMatchObject({ state: "queued" });
    expect((await view(e)).cards).toEqual({ v1: { cards: [], note: `Cards: the corrected cards were not drawn (${THREW})` } });
    expect(readCards(e, "v1")).toMatchObject({ calls: 3, draws: 2, done: true });
    expect(cardsOnCut(e)).toEqual([]);
    await call("maker", "POST", `/api/editor/${e}/stop`);
  });

  it("a fix that gives the same script back, or no script: nothing is drawn, and the version goes on with the Mac's words", async () => {
    for (const reply of [BROKEN, "```js\n" + BROKEN + "\n```", "I can't see what is wrong."]) {
      const e = await newEdit();
      asked = [];
      answers = [PLAN, BROKEN, reply];
      await toCards(e);
      await throws();
      await step();
      expect(asked, reply).toHaveLength(3);
      expect(await claim()).toEqual({ job: null });
      expect(jobOf(e, CARDS_DRAW_KIND)).toBeUndefined();
      expect(jobOf(e, "post")).toMatchObject({ state: "queued" });
      expect((await view(e)).cards).toEqual({ v1: { cards: [], note: `Cards: ${THREW}` } });
      expect(readCards(e, "v1")).toMatchObject({ calls: 3, draws: 1, done: true });
      await call("maker", "POST", `/api/editor/${e}/stop`);
    }
  });

  it("stopped while the fix is asked, then run again: no second fix call, the Mac's words as the note", async () => {
    const e = await newEdit();
    answers = [PLAN, BROKEN, async () => {
      await call("maker", "POST", `/api/editor/${e}/stop`);
      throw new Error("The request was stopped");
    }];
    await toCards(e);
    await throws();
    await step();
    expect(asked).toHaveLength(3);
    expect(jobOf(e, "cards")).toMatchObject({ state: "failed", error: "Stopped" });
    expect(readCards(e, "v1")).toMatchObject({ calls: 3, draws: 1, fixed: true, threw: THREW });
    const cards = libraryDb().prepare("SELECT id FROM edit_jobs WHERE edit_id = ? AND kind = 'cards'").get(e) as { id: number };
    expect((await call("maker", "POST", `/api/editor/${e}/jobs/${cards.id}/retry`)).status).toBe(200); // the edit page's Retry
    only(e);
    await step();
    expect(asked).toHaveLength(3);
    expect(await claim()).toEqual({ job: null });
    expect((await view(e)).cards).toEqual({ v1: { cards: [], note: `Cards: ${THREW}` } });
    await call("maker", "POST", `/api/editor/${e}/stop`);
  });

  it("at the cap: the plan, the make, one fix and one look call, and three draws, never more", async () => {
    const e = await newEdit();
    const better = `${FIXED}\n// bigger words`;
    answers = [PLAN, BROKEN, FIXED, better];
    await toCards(e);
    await throws();
    await step(); // the fix
    await drawOnMac();
    await step(); // the look corrects it
    expect((await drawOnMac({ colour: "blue" })).script).toBe(better);
    await step();
    expect(asked).toHaveLength(MAX_CALLS);
    expect(MAX_CALLS).toBe(4);
    expect(readCards(e, "v1")).toMatchObject({ calls: MAX_CALLS, draws: MAX_DRAWS, done: true });
    expect(MAX_DRAWS).toBe(3);
    expect(await claim()).toEqual({ job: null });
    expect(cardsOnCut(e)).toHaveLength(2);
    await call("maker", "POST", `/api/editor/${e}/stop`);
  });
});

describe.skipIf(rootReplaced)("cards never hold an edit up", () => {
  const ended = async (id: string) => {
    expect(jobOf(id, "cards")).toMatchObject({ state: "done" });
    expect(jobOf(id, CARDS_DRAW_KIND)).toBeUndefined();
    expect(jobOf(id, "post")).toMatchObject({ state: "queued" });
    await call("maker", "POST", `/api/editor/${id}/stop`);
    return (await view(id, readEdit(id)!.createdBy)).cards?.v1;
  };

  it("no Mac of the account is on: a note, no AI call, the preview's turn; the next cut tries again", async () => {
    const theirs = await json<AnimationStyle>(call("nomac", "POST", "/api/editor/animation-styles", { name: "Mine" }));
    const s = await json<EditingStyle>(call("nomac", "POST", "/api/editor/styles", { name: "With cards", animation: theirs.id }));
    const { id } = await json<{ id: string }>(call("nomac", "POST", "/api/editor", { name: "Rolling", sources: ["ver_n"], style: s.id }));
    const tl = timeline();
    tl.sources = { ver_n: { ...tl.sources.ver_a!, versionId: "ver_n" } };
    for (const t of ["V1", "A1"] as const) tl.tracks[t].items = tl.tracks[t].items.map((i) => ({ ...i, src: "ver_n" }));
    tl.tracks.V2.items = [];
    await saveStep(id, "analysis", { sentences: sentences.map((x) => ({ ...x, src: "ver_n" })), notes: [] });
    await saveStep(id, "plan", plan());
    await saveDraft(id, "v1", { timeline: tl, notes: [] });
    enqueueJob(libraryDb(), "nomac", `${id}:v1`, "broll", "nomac", true, "edit_jobs");
    await toCards(id);
    expect(asked).toEqual([]);
    expect(jobs(id).map((j) => [j.kind, j.state])).toEqual([["broll", "done"], ["cards", "done"], ["post", "queued"]]);
    expect((await view(id, "nomac")).cards).toEqual({ v1: { cards: [], note: "Cards: no Mac with Creator Toolset is on" } });
    expect(readCards(id, "v1")).toMatchObject({ calls: 0, done: false });
    expect(readDraft(id, "v1")!.timeline).toEqual(tl);
    await call("nomac", "POST", `/api/editor/${id}/stop`);
  });

  it("a draw nobody takes in 10 minutes is taken back: a note, and the preview's turn", async () => {
    const id = await newEdit();
    answers = [PLAN, SCRIPT];
    await toCards(id);
    expect(jobOf(id, CARDS_DRAW_KIND)).toMatchObject({ state: "queued" });
    // nine minutes on it still waits
    const asked0 = Date.now();
    clock.now = () => asked0 + 9 * 60_000;
    await step();
    expect(jobOf(id, CARDS_DRAW_KIND)).toMatchObject({ state: "queued" });
    expect(jobOf(id, "cards")).toMatchObject({ state: "queued" });
    clock.now = () => asked0 + 10 * 60_000 + 1000;
    await step();
    expect(await ended(id)).toEqual({ cards: [], note: "Cards: your Mac did not take the draw in 10 minutes" });
    expect(await claim()).toEqual({ job: null }); // nothing is left to take
    expect(asked).toHaveLength(2);
    expect(cardsOnCut(id)).toEqual([]);
  });

  it("a draw that fails is tried again as any device step is, with no AI call: the Mac draws every card again and the newer ones are kept", async () => {
    const id = await newEdit();
    answers = [PLAN, SCRIPT, "OK"];
    await toCards(id);
    await drawOnMac({ fail: "Card 2 of 2 took longer than 20 seconds to draw.", skip: ["c2"] });
    expect(jobOf(id, CARDS_DRAW_KIND)).toEqual({ kind: CARDS_DRAW_KIND, state: "queued", error: "Card 2 of 2 took longer than 20 seconds to draw." });
    await step(); // the cards step still waits
    expect(jobOf(id, "cards")).toMatchObject({ state: "queued" });
    expect(asked).toHaveLength(2);
    await drawOnMac({ colour: "blue" });
    await step();
    expect(asked).toHaveLength(3); // the look, once
    expect(await ended(id)).toEqual({ cards: [{ id: "c1", text: "Tuck your chin", liked: false }, { id: "c2", text: "Push with both hands", liked: false }] });
    expect(readFileSync(path.join(editDir(id), "cards", "v1", "c1.mp4")).equals(readFileSync(path.join(dir, "card-blue-2.4.mp4")))).toBe(true);
    expect(readCards(id, "v1")).toMatchObject({ calls: 3, draws: 1, done: true }); // one script was sent to be drawn
  });

  it("a draw that failed for good (three attempts): the cards that did arrive go on, with the Mac's own words", async () => {
    const id = await newEdit();
    answers = [PLAN, SCRIPT];
    await toCards(id);
    for (let attempt = 1; attempt <= 3; attempt++) await drawOnMac({ fail: "Card 2 of 2 took longer than 20 seconds to draw.", skip: ["c2"] });
    expect(jobOf(id, CARDS_DRAW_KIND)).toMatchObject({ state: "failed" });
    expect(await claim()).toEqual({ job: null });
    await step();
    expect(await ended(id)).toEqual({ cards: [{ id: "c1", text: "Tuck your chin", liked: false }], note: "Cards: Card 2 of 2 took longer than 20 seconds to draw." });
    expect(cardsOnCut(id).map((i) => i.src)).toEqual(["card-c1"]);
    expect(asked).toHaveLength(2); // a draw that failed is not looked at
    expect(readCards(id, "v1")).toMatchObject({ draws: 1, done: true });

    const none = await newEdit();
    answers = [PLAN, SCRIPT];
    await toCards(none);
    for (let attempt = 1; attempt <= 3; attempt++) await drawOnMac({ fail: "Cards can't be drawn on this Mac: this macOS has no switch for link preconnect.", skip: ["c1", "c2"] });
    await step();
    expect(await ended(none)).toEqual({ cards: [], note: "Cards can't be drawn on this Mac: this macOS has no switch for link preconnect." });
    expect(cardsOnCut(none)).toEqual([]);
  });

  it("a draw over 20 minutes is taken back, and so is one whose Mac goes off while it draws", async () => {
    const id = await newEdit();
    answers = [PLAN, SCRIPT];
    await toCards(id);
    expect((await claim()).job).not.toBeNull();
    const asked0 = Date.now();
    clock.now = () => asked0 + 19 * 60_000;
    await step();
    expect(jobOf(id, CARDS_DRAW_KIND)).toMatchObject({ state: "running" });
    clock.now = () => asked0 + 20 * 60_000 + 1000;
    await step();
    expect(await ended(id)).toEqual({ cards: [], note: "Cards: the draw took over 20 minutes" });

    const quiet = await newEdit();
    answers = [PLAN, SCRIPT];
    await toCards(quiet);
    expect((await claim()).job).not.toBeNull();
    // 41 seconds with no word from the Mac: it counts as off, and its step goes back in the queue (engine.ts)
    const real = Date.now;
    const later = vi.spyOn(Date, "now").mockImplementation(() => real() + 41_000);
    try {
      await step();
    } finally {
      later.mockRestore();
    }
    expect(await ended(quiet)).toEqual({ cards: [], note: "Cards: no Mac with Creator Toolset is on" });
    expect(await claim()).toEqual({ job: null }); // the Mac is back, and there is nothing left for it to take
  });

  it("an AI answer that cannot be used ends in a note after that one call: no second ask, no draw", async () => {
    const id = await newEdit();
    answers = ["I would rather not."];
    await toCards(id);
    expect(asked).toHaveLength(1);
    expect(await ended(id)).toEqual({ cards: [], note: "Cards: the AI's answer was not a list of cards" });

    const long = await newEdit();
    asked = [];
    answers = [PLAN, `function kitFrame(t, card) {}\n${"/".repeat(SCRIPT_MAX)}`];
    await toCards(long);
    expect(asked).toHaveLength(2);
    expect(await ended(long)).toEqual({ cards: [], note: "Cards: the AI's card script is over 60,000 characters" });
    expect(existsSync(path.join(editDir(long), "cards", "v1", "script.txt"))).toBe(false);

    const none = await newEdit();
    asked = [];
    answers = ['{"cards":[]}'];
    await toCards(none);
    expect(asked).toHaveLength(1);
    expect(await ended(none)).toEqual({ cards: [], note: "Cards: the AI found no line that needs one" });
  });

  it("a style that is not the person's own reaches no AI call", async () => {
    change("maker", (f) => void (f.animation!.find((a) => a.id === anim.id)!.from = "tiny-looks"));
    try {
      const id = await newEdit();
      await toCards(id);
      expect(asked).toEqual([]);
      expect(await ended(id)).toEqual({ cards: [], note: "Cards: a style from Community makes no cards" });
    } finally {
      change("maker", (f) => void delete f.animation!.find((a) => a.id === anim.id)!.from);
    }
  });
});

describe.skipIf(rootReplaced)("how the Mac learns that a step waits", () => {
  it("a poll that lists the kind is answered with the hint when a draw waits; one that lists none is held as ever, and so is another account's", async () => {
    const id = await newEdit();
    answers = [PLAN, SCRIPT];
    await toCards(id);
    expect(jobOf(id, CARDS_DRAW_KIND)).toMatchObject({ state: "queued" });
    // a Mac app from before this (its poll has no `editor`) is never sent the hint: it could not read it
    expect(await held(mac.token, { blobs: true })).toBe(204);
    expect(await held(mac.token, {})).toBe(204);
    expect(await held(mac.token, { blobs: true, editor: "cards-draw" })).toBe(204); // no list of kinds: read as none sent
    expect(deviceOf(mac.device.id)?.kinds).toEqual([CARDS_DRAW_KIND]); // and what the Mac listed before stays
    // the step is another account's: nothing for this Mac
    expect(await held(other.token)).toBe(204);
    // the hint, word for word, and the step is still there to claim: the hint took nothing
    const told = await poll();
    expect([told.status, await told.text()]).toEqual([200, '{"editor":true}']);
    expect(jobOf(id, CARDS_DRAW_KIND)).toMatchObject({ state: "queued" });
    await call("maker", "POST", `/api/editor/${id}/stop`);
    expect(await held()).toBe(204); // stopped: nothing waits
  }, 60_000);

  it("an AI request that waits for the Mac goes first, and the hint comes on the poll after it", async () => {
    const id = await newEdit();
    answers = [PLAN, SCRIPT];
    await toCards(id);
    const ai = streamMacClaude("system", "user", undefined, () => {}, undefined, { provider: { instance: "claude", driver: "claude", model: "m", effort: "low", device: mac.device.id } });
    const first = await json<{ id?: string; editor?: boolean }>(poll());
    expect(first.id).toBeTruthy();
    expect(first).not.toHaveProperty("editor");
    await app.request(`/api/devices/relay/${first.id}/done`, { method: "POST", headers: { authorization: `Bearer ${mac.token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "answered" }) });
    expect(await ai).toBe("answered");
    expect(await json(poll())).toEqual(EDITOR_HINT);
    await call("maker", "POST", `/api/editor/${id}/stop`);
  });

  it("done says when another step waits, so the Mac claims it with no poll between; the last one says nothing more", async () => {
    const one = await newEdit();
    answers = [PLAN, SCRIPT];
    await toCards(one);
    const two = await newEdit();
    answers = [PLAN, SCRIPT];
    libraryDb().prepare("UPDATE edit_jobs SET state = 'failed', error = 'Stopped' WHERE edit_id = ? AND kind = 'cards'").run(one); // so the worker's next steps are the second edit's
    libraryDb().prepare("UPDATE edit_jobs SET state = 'queued', error = NULL WHERE edit_id = ? AND kind = 'cards-draw'").run(one);
    await step();
    await step();
    expect([jobOf(one, CARDS_DRAW_KIND)?.state, jobOf(two, CARDS_DRAW_KIND)?.state]).toEqual(["queued", "queued"]);
    expect(await json(poll())).toEqual(EDITOR_HINT);
    const a = (await claim()).job!;
    expect(await json(relay(mac.token, "POST", `/job/${a.id}/done`, "{}"))).toEqual({ ok: true, editor: true });
    const b = (await claim()).job!; // at once: no poll went between
    expect(b.editId).not.toBe(a.editId);
    // a fail puts the step back for later (a minute on): nothing to claim now, so no word
    expect(await json(relay(mac.token, "POST", `/job/${b.id}/fail`, JSON.stringify({ error: "Card 1 of 2 drew nothing." })))).toEqual({ ok: true });
    for (const e of [one, two]) await call("maker", "POST", `/api/editor/${e}/stop`);
  });

  it("a Mac that says it can draw nothing (an empty list) is no longer a Mac that draws cards: the version gets its note", async () => {
    try {
      expect(await held(mac.token, { blobs: true, editor: [] })).toBe(204);
      expect(deviceOf(mac.device.id)?.kinds).toEqual([]);
      const id = await newEdit();
      await toCards(id);
      expect(asked).toEqual([]);
      expect((await view(id)).cards).toEqual({ v1: { cards: [], note: "Cards: no Mac with Creator Toolset is on" } });
      await call("maker", "POST", `/api/editor/${id}/stop`);
    } finally {
      await held(); // it lists the kind again
    }
    expect(deviceOf(mac.device.id)?.kinds).toEqual([CARDS_DRAW_KIND]);
  }, 60_000);
});

describe.skipIf(rootReplaced)("the device contract", () => {
  it("only the Mac that holds the step reads the cards or sends one, a card is one of the plan's, and the files are what they say", async () => {
    const id = await newEdit();
    answers = [PLAN, SCRIPT];
    await toCards(id);
    const { job } = await claim();
    const base = `/job/${job!.id}/cards`;
    expect((await relay(other.token, "GET", base, undefined, "")).status).toBe(404);
    expect((await relay(other.token, "POST", `${base}/c1`, cardForm(2.4), "")).status).toBe(404);
    expect((await relay("ctd_not-a-token", "GET", base, undefined, "")).status).toBe(401);
    expect((await relay(mac.token, "GET", `/job/${job!.id + 999}/cards`, undefined, "")).status).toBe(404);
    for (const bad of ["c3", "..%2F..%2Fedit", "c1%2F..%2Fc2"]) expect((await relay(mac.token, "POST", `${base}/${bad}`, cardForm(2.4), "")).status).toBe(404);

    const two = cardForm(2.4);
    two.delete("still");
    expect((await relay(mac.token, "POST", `${base}/c1`, two, "")).status).toBe(400);
    const text = new FormData();
    text.append("clip", new File(["not a film"], "card.mp4"));
    for (let i = 0; i < 3; i++) text.append("still", new File([readFileSync(red)], "s.png"));
    expect((await relay(mac.token, "POST", `${base}/c1`, text, "")).status).toBe(400);
    expect(existsSync(path.join(editDir(id), "cards", "v1", "draw"))).toBe(false); // nothing was kept

    // the same card sent twice: the newer one is the one kept
    expect((await relay(mac.token, "POST", `${base}/c1`, cardForm(2.4), "")).status).toBe(200);
    expect(await json(relay(mac.token, "POST", `${base}/c1`, cardForm(2.4, "blue"), ""))).toEqual({ ok: true });
    expect(readFileSync(path.join(editDir(id), "cards", "v1", "draw", "c1.mp4")).equals(readFileSync(path.join(dir, "card-blue-2.4.mp4")))).toBe(true);

    // a step taken back takes nothing more
    await call("maker", "POST", `/api/editor/${id}/stop`);
    expect((await relay(mac.token, "POST", `${base}/c2`, cardForm(1.2), "")).status).toBe(404);
    expect(await json(relay(mac.token, "POST", `/job/${job!.id}/beat`, "{}"))).toEqual({ ok: false });
  });
});

describe("what the Mac said", () => {
  it("a script that threw is told by the Mac's own words (CardJobs.swift), and no other failure is", () => {
    const swift = readFileSync(path.join(import.meta.dirname, "../../../../mac/Sources/CreatorToolsetMac/CardJobs.swift"), "utf8");
    expect(swift).toContain('case KitRunnerError.badCard(let why): return "has a script that failed (\\(why.prefix(200)))."');
    expect(swift).toContain('failed.append("\\(name) \\(cardFailure(error, limit: limit))")');
    expect(scriptThrew("Card 2 of 4 has a script that failed (Error: no such font). Card 3 of 4 drew nothing.")).toBe(true);
    for (const other of ["Card 2 of 2 took longer than 20 seconds to draw.", "Card 1 of 2 drew nothing.", "Card 1 of 2 made its page stop (it crashed, or took too much memory).", "Card 1 of 2 could not be made into a clip (writer).", "Cards can't be drawn on this Mac: this macOS has no switch for link preconnect.", "device went quiet", "lease expired", "Stopped", "has a script that failed (no card named)", null]) {
      expect(scriptThrew(other), String(other)).toBe(false);
    }
  });

  it("the fix call carries 500 characters of the Mac's words at most", () => {
    const f = { brief: "", width: 360, height: 640, fps: 30, cards: [] };
    const words = `Card 1 of 1 has a script that failed (${"x".repeat(ERROR_MAX)}).`;
    expect(ERROR_MAX).toBe(500);
    expect(fixPrompt({ ...f, script: SCRIPT, error: words }).user.endsWith(`What the Mac said:\n${words.slice(0, ERROR_MAX)}`)).toBe(true);
    expect(fixPrompt({ ...f, script: SCRIPT, error: words.slice(0, ERROR_MAX) }).user).toBe(fixPrompt({ ...f, script: SCRIPT, error: words }).user);
  });
});

describe("where a card goes", () => {
  it("at 29.97 and 23.976 frames a second a card drawn for its room fills it to the frame", () => {
    for (const fps of [23.976, 29.97, 59.94]) {
      const t = timeline();
      t.fps = fps;
      t.tracks.V2.items = [];
      const room = cardWindow(t, "L2")!;
      // the clip the Mac draws for that room: its seconds to three places, and as many frames as that comes to
      const seconds = Math.round((room.len / fps) * 1000) / 1000;
      const dur = Math.round(seconds * fps);
      const laid = placeCards(t, [{ key: "card-c1", text: "Tuck your chin", line: "L2", source: { versionId: "card-c1", name: "Card 1", fps, tc: 0, dur, w: 360, h: 640, file: "cards/v1/c1.mp4" } }]);
      expect(laid.notes, String(fps)).toEqual([]);
      expect(laid.timeline.tracks.V2.items, String(fps)).toEqual([{ src: "card-c1", in: 0, len: room.len, rec: room.rec }]);
    }
  });

  it("never in the hook, never over the last line, and never over a shot too short to keep his face first", () => {
    const t = timeline();
    expect(cardWindow(t, "L1")).toEqual({ rec: 44, len: 46 }); // after the hook's 1.5 s
    expect(cardWindow(t, "L2")).toEqual({ rec: 138, len: 72 }); // 2.4 s at most, ending on his cut
    expect(cardWindow(t, "L3")).toEqual({ rec: 234, len: 36 }); // 1.2 s at least
    expect(cardWindow(t, "L4")).toBeNull(); // the last line
    t.tracks.V1.items[2]!.len = 59; // one frame short of his face (0.8 s) and the shortest card (1.2 s)
    expect(cardWindow(t, "L3")).toBeNull();
  });
});

describe.skipIf(rootReplaced)("the caps", () => {
  it("6 cards a version and 60 characters a card, whatever the AI answers", () => {
    const lines = Array.from({ length: 9 }, (_, k) => ({ n: k + 1, text: `Line ${k + 1}`, ok: k !== 3 }));
    const picked = parsePlan(JSON.stringify({ cards: [{ line: 4, text: "no room there" }, { line: 1, text: "w".repeat(80) }, { line: 1, text: "twice" }, { line: 99, text: "no such line" }, ...lines.slice(1).map((l) => ({ line: l.n, text: `Card ${l.n}` }))] }), lines);
    expect(picked).toHaveLength(MAX_CARDS);
    expect(picked.map((c) => c.line)).toEqual([1, 2, 3, 5, 6, 7]);
    expect(picked[0]!.text).toHaveLength(CARD_TEXT_MAX);
    expect(() => parsePlan("no JSON here", lines)).toThrow();
  });

  it("a script of 60,000 characters is taken, one character more is refused, and a code fence is dropped", () => {
    const at = (n: number) => `function kitFrame(t, card) {}${" ".repeat(n - 30)}.`;
    expect(parseScript(at(SCRIPT_MAX))).toHaveLength(SCRIPT_MAX);
    expect(() => parseScript(at(SCRIPT_MAX + 1))).toThrow("over 60,000 characters");
    expect(parseScript("```javascript\nfunction kitFrame() {}\n```")).toBe("function kitFrame() {}");
    expect(() => parseScript("Here is some advice.")).toThrow("not a card script");
  });

  it("8 pictures in the make call, the liked ones first; the look gets its sheet and 4; the sheet is at most 2048 px and 600 KB", async () => {
    const liked = path.join(dir, "liked.png");
    execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=540x960", "-frames:v", "1", liked]);
    for (let i = 0; i < 3; i++) await addPicture("maker", anim.id, liked, "made");
    for (let i = 0; i < 12; i++) await addPicture("maker", anim.id, red, "inspiration");
    const made = animationStyles("maker")[0]!.pictures.filter((p) => p.kind === "made");
    expect(animationStyles("maker")[0]!.pictures.length).toBeGreaterThan(MAKE_PICTURES + 4);

    const id = await newEdit();
    answers = [PLAN, SCRIPT, "OK"];
    await toCards(id);
    expect(asked[1]!.images).toHaveLength(MAKE_PICTURES);
    // the newest liked stills lead (the one liked on a card earlier, then these three)
    const first = readFileSync(path.join(dir, "editor-styles", "maker", anim.id, `${made.at(-1)!.id}.jpg`)).toString("base64");
    expect(asked[1]!.images[0]).toBe(first);
    expect(asked[1]!.text).toContain(`Pictures 1 to ${made.length}: stills of cards the author liked in earlier videos. Pictures ${made.length + 1} to 8: inspirations the author collected.`);
    await drawOnMac();
    await step();
    expect(asked[2]!.images).toHaveLength(1 + LOOK_PICTURES);
    const sheet = path.join(dir, "sheet.jpg");
    writeFileSync(sheet, Buffer.from(asked[2]!.images[0]!, "base64"));
    expect(statSync(sheet).size).toBeLessThanOrEqual(SHEET_MAX_BYTES);
    const [w, h] = ffprobe(sheet, "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0").split(",").map(Number);
    expect(Math.max(w!, h!)).toBeLessThanOrEqual(SHEET_MAX_SIDE);
    expect(w! / h!).toBeCloseTo((2 * 540) / (3 * 960), 2); // two cards side by side, three stills down
    expect(asked[2]!.text).toContain("The other 4 are the author's: the look.");
    await call("maker", "POST", `/api/editor/${id}/stop`);
  });
});
