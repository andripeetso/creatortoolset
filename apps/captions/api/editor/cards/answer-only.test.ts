import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, DRIVERS, type Driver } from "../../../contracts/providers";

// What the three card calls (plan, make, look) carry when they leave the server, for every way an account's AI can
// answer: its own Anthropic key, a model it runs itself, and each kind of AI on a Mac of its own. The server decides four things about a call
// and this file pins each of them: no web, no session to resume, none of the app's tools (no MCP server, no
// permission questions), and no folder beyond the pictures the call itself carries.
//
// What a Mac's command line then does with such a request is the Mac app's code, and is pinned by its own tests
// (apps/mac/Tests/CreatorToolsetMacTests): a request with no folder and no web starts Claude with an empty tool list
// (RelayTests.testPlainRunHasNoToolsAndNoSession) and Grok with its to-do list alone and web search off
// (testGrokCommandLineNeverHasFileTools): those two, and the key, can only answer.
// The other kinds can do more than answer even for a request in words alone (read in the Mac app's code, not run here):
//   - Codex always has its shell, shut in a read-only profile with no network
//     (testACodexThatTakesAProfileRunsFencedAndAnOlderOneIsNotRun);
//   - Gemini runs in plan mode with its read tools, in an empty folder of the run's own, and its command line takes
//     no switch for the web, so its web search is not ruled out;
//   - Muse Code starts with no built-in tools (MuseTests.testNoFolderAndNoWebMeansNoToolsAndNothingEverWritesOrRuns),
//     but loads the MCP servers the person listed in its own settings;
//   - OpenCode has its read tools, kept to the run's folder (testAnOpenCodeRunGetsRulesThatKeepItInItsFolder);
//   - Cursor, Antigravity, Pi and a local ACP command get no rules from the app: a question they would ask is refused.
// A call WITH pictures on a Mac is not answer-only on any kind: the pictures are files in the run's own folder, read
// with that AI's read tools (RelayTests.testFolderAndWebGetTheReadTools), and Grok takes no pictures at all
// (testAGrokRunHasNoFolderOfFiles). That is why only a style the person made reaches these calls (step.ts).

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "cards-answer-only-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "cards-answer-only-test-secret";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_BASE_URL;

const { createUser } = await import("../../users");
const app = (await import("../../boot")).default;
const { aiFor } = await import("../../ai-complete");
const { pairDevice, devicesSaved } = await import("../../lib/devices");
const { installPack } = await import("../../lib/packs");
const { saveSettings } = await import("../../lib/providers");
const { saveMyKey } = await import("../../my-keys");
const { lookPrompt, makePrompt, parseLook, parseScript, planPrompt } = await import("./prompts");
const { answer, LOOK_PICTURES, MAKE_PICTURES, planPackText } = await import("./step");

createUser("keyed", "password1", { role: "user" });
createUser("onmac", "password1", { role: "user" });
// an install's own admin with a model it runs itself (Settings → API keys → Local model), and no Anthropic key
createUser("ownmodel", "password1", { role: "admin" });
mkdirSync(path.join(dir, "local-model"), { recursive: true });
writeFileSync(path.join(dir, "local-model", "ownmodel.json"), JSON.stringify({ url: "http://127.0.0.1:9", model: "tiny-model" }));
saveMyKey("keyed", "ANTHROPIC_API_KEY", "test-key-of-the-account");
const mac = pairDevice("onmac", "Studio Mac");

afterAll(async () => {
  await devicesSaved();
  await new Promise((r) => setTimeout(r, 300)); // an answer's usage is written after it: let the last one land before its folder goes
  rmSync(dir, { recursive: true, force: true });
});

/* ---- the three calls, as the step makes them ---- */

const picture = { jpegBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") };
const frame = { brief: "Big white words on deep red.", width: 1080, height: 1920, fps: 30, cards: [{ id: "c1", text: "Tuck your chin", first: 2, last: 2, line: "First, tuck your chin.", seconds: 2.4 }] };
const SCRIPT = "function kitFrame(t, card) {}";
const CALLS = [
  { name: "plan", prompt: planPrompt({ lines: [{ n: 1, text: "First, tuck your chin.", ok: true }], brief: frame.brief, packText: "Instructions from packs the author installed." }), images: [], parse: (t: string) => t, reply: '{"cards":[]}' },
  { name: "make, in words alone (a style with no picture)", prompt: makePrompt({ ...frame, made: 0, inspirations: 0 }), images: [], parse: parseScript, reply: SCRIPT },
  { name: "make, with the style's pictures", prompt: makePrompt({ ...frame, made: 3, inspirations: 5 }), images: Array.from({ length: MAKE_PICTURES }, () => picture), parse: parseScript, reply: SCRIPT },
  { name: "look", prompt: lookPrompt({ ...frame, script: SCRIPT, columns: true, pictures: LOOK_PICTURES }), images: Array.from({ length: 1 + LOOK_PICTURES }, () => picture), parse: parseLook, reply: "OK" },
] as const;

describe("on the account's own Anthropic key", () => {
  let bodies: Record<string, unknown>[] = [];
  beforeEach(() => {
    bodies = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages"); // and nothing else is asked for
      bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
      return new Response(JSON.stringify({ content: [{ type: "text", text: CALLS.find((c) => (bodies.at(-1)!.system as string) === c.prompt.system)!.reply }], usage: {} }), { status: 200 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(CALLS)("$name: a question and its pictures, with no tool, no server tool and nothing to call", async (c) => {
    expect(aiFor("keyed", "editor", "x").only).toEqual(["anthropic"]);
    await answer("keyed", c.prompt, [...c.images], c.parse as (t: string) => unknown);
    expect(bodies).toHaveLength(1); // one request a call
    const body = bodies[0]!;
    // the whole request: no `tools`, `tool_choice`, `mcp_servers` or `container` key exists to ask with
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system"]);
    expect(body.system).toBe(c.prompt.system);
    const messages = body.messages as { role: string; content: string | { type: string; text?: string }[] }[];
    expect(messages).toHaveLength(1);
    const content = messages[0]!.content;
    if (!c.images.length) return expect(content).toBe(c.prompt.user);
    const blocks = content as { type: string; text?: string }[];
    expect(blocks.map((b) => b.type)).toEqual([...c.images.map(() => "image"), "text"]);
    expect(blocks.at(-1)!.text).toBe(c.prompt.user);
  });
});

describe("on a model the person runs themselves", () => {
  let sent: { url: string; body: Record<string, unknown> }[] = [];
  beforeEach(() => {
    sent = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(init!.body as string) as Record<string, unknown> });
      // the question asked first (does the request fit?): this stand-in has no such route; then the answer
      if (String(url).endsWith("/api/chat")) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify({ content: [{ type: "text", text: CALLS.find((c) => sent.at(-1)!.body.system === c.prompt.system)!.reply }], usage: {} }), { status: 200 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(CALLS.filter((c) => !c.images.length))("$name: the question goes to their address alone, with no tool to call", async (c) => {
    expect(aiFor("ownmodel", "editor", "x").only).toEqual(["localModel"]);
    await answer("ownmodel", c.prompt, [], c.parse as (t: string) => unknown);
    expect(sent.map((x) => x.url)).toEqual(["http://127.0.0.1:9/api/chat", "http://127.0.0.1:9/v1/messages"]);
    // does it fit, then the request: both are the system and user text and nothing a model could call
    expect(Object.keys(sent[0]!.body).sort()).toEqual(["messages", "model", "options", "stream", "think", "truncate"]);
    expect(Object.keys(sent[1]!.body).sort()).toEqual(["max_tokens", "messages", "model", "system", "thinking"]);
    expect(sent[1]!.body).toMatchObject({ model: "tiny-model", system: c.prompt.system, messages: [{ role: "user", content: c.prompt.user }] });
  });

  it.each(CALLS.filter((c) => c.images.length))("$name: a call with pictures is never sent to that address, and with no key of the account's it is not sent at all", async (c) => {
    await expect(answer("ownmodel", c.prompt, [...c.images], c.parse as (t: string) => unknown)).rejects.toThrow("A local model answers text only");
    expect(sent).toEqual([]);
  });
});

describe("on an AI of the account's own Mac", () => {
  type Job = Record<string, unknown> & { id: string; files?: Record<string, string> };
  const relay = (url: string, body: unknown) =>
    app.request(`/api/devices/relay/${url}`, { method: "POST", headers: { authorization: `Bearer ${mac.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  // every kind of AI the app runs on a Mac: a kind added to the list is in this test from that day
  it.each(DRIVERS.map((d) => d.id))("%s: each call is sent with no web, no session, none of the app's tools, and no file but its own pictures", async (driver: Driver) => {
    const acp = driver === "acp" ? { acp: { command: "tiny-agent", args: ["acp"] } } : {};
    await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: `${driver}_mine`, driver, name: driver, enabled: true, device: mac.device.id, ...acp }] }, "onmac");
    expect(aiFor("onmac", "editor", "x").only).toEqual(["mac"]);
    for (const c of CALLS) {
      const asked = answer("onmac", c.prompt, [...c.images], c.parse as (t: string) => unknown);
      const job = (await (await relay("wait", {})).json()) as Job;
      // the request as the Mac gets it: these keys and no other
      const known = ["id", "device", "system", "user", "web", "instance", "driver", "effort", "model", "scope", ...(c.images.length ? ["files"] : []), ...(driver === "acp" ? ["acp"] : [])];
      expect(Object.keys(job).sort(), c.name).toEqual(known.sort());
      expect(job).toMatchObject({ driver, web: false, system: c.prompt.system });
      for (const never of ["session", "resume", "mcp", "asks"]) expect(job, c.name).not.toHaveProperty(never);
      if (c.images.length) {
        // the pictures the call carries, and nothing else, are the run's folder
        expect(Object.keys(job.files!)).toEqual(c.images.map((_, i) => `attached/${i + 1}.jpg`));
        expect(Object.values(job.files!).every((f) => f === `base64:${picture.jpegBase64}`)).toBe(true);
        expect((job.user as string).startsWith(c.prompt.user)).toBe(true);
      } else expect(job.user).toBe(c.prompt.user);
      expect((await relay(`${job.id}/done`, { text: c.reply })).status).toBe(200);
      await asked;
    }
  });
});

describe("text other people wrote (an installed pack's card instructions)", () => {
  // a pack from Community with words for the cards; the app's own basics pack, which every account starts with, has some too
  const theirs = {
    format: 1, id: "tiny-cards", name: "Tiny cards", version: "1.0.0", author: "tinyacrobatics", license: "CC0-1.0",
    description: "Card instructions someone else wrote.", instructions: { "editor.cards": "Put a card on every question." },
  } as unknown as Parameters<typeof installPack>[1];

  it("reaches the plan call on the account's own key and on a model it runs itself, and on a Mac only the app's own shipped packs' does", async () => {
    for (const user of ["keyed", "ownmodel", "onmac"]) await installPack(user, theirs, 0);
    for (const user of ["keyed", "ownmodel"]) {
      const text = await planPackText(user);
      expect(text, user).toContain("Put a card on every question.");
      expect(text, user).toContain("One idea per card"); // the app's own
    }
    // whichever kind of AI the Mac runs: a call that meets a usage limit moves to another of the account's
    for (const driver of DRIVERS.map((d) => d.id)) {
      await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: `${driver}_mine`, driver, name: driver, enabled: true, device: mac.device.id, ...(driver === "acp" ? { acp: { command: "tiny-agent", args: ["acp"] } } : {}) }] }, "onmac");
      const text = await planPackText("onmac");
      expect(text, driver).not.toContain("Put a card on every question.");
      expect(text, driver).not.toContain("Tiny cards");
      expect(text, driver).toContain("One idea per card");
    }
  });
});

describe("what the three questions are made of", () => {
  it("installed packs' text reaches the plan alone: the make and the look call take no text but the app's and the person's", () => {
    expect(makePrompt).toHaveLength(1);
    expect(lookPrompt).toHaveLength(1);
    const [plan, , make, look] = CALLS;
    expect(plan.prompt.system).toContain("Instructions from packs the author installed.");
    for (const c of [make, look]) expect(`${c.prompt.system}\n${c.prompt.user}`).not.toContain("packs");
  });

  it("each asks for an answer and nothing else, and says what a script has on the Mac that draws it", () => {
    const [plan, , make, look] = CALLS;
    expect(plan.prompt.system).toContain("Answer with JSON only");
    expect(make.prompt.system).toContain("Answer with the script only");
    expect(look.prompt.system).toContain("answer with the two letters OK and nothing else");
    for (const c of [make, look]) {
      for (const said of ["kitFrame(t, card)", 'the id "stage", a <div> (not a canvas', "black, with white text", "no timers, no CSS transitions or animations", "Pictures only as data: addresses", "no WebGL, WebAssembly or audio", "within 20 seconds", "never empty at its first, middle or last frame"]) {
        expect(c.prompt.system).toContain(said);
      }
    }
  });
});
