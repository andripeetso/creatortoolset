import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, DRIVERS, type Driver } from "../../../contracts/providers";

// What the three card calls (plan, make, look) carry when they leave the server, for every way an account's AI can
// answer: its own Anthropic key, and each kind of AI on a Mac of its own. The server decides four things about a call
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
const { saveSettings } = await import("../../lib/providers");
const { saveMyKey } = await import("../../my-keys");
const { lookPrompt, makePrompt, parseLook, parseScript, planPrompt } = await import("./prompts");
const { answer, LOOK_PICTURES, MAKE_PICTURES } = await import("./step");

createUser("keyed", "password1", { role: "user" });
createUser("onmac", "password1", { role: "user" });
saveMyKey("keyed", "ANTHROPIC_API_KEY", "test-key-of-the-account");
const mac = pairDevice("onmac", "Studio Mac");

afterAll(async () => {
  await devicesSaved();
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
      for (const said of ["kitFrame(t, card)", 'the id "stage"', "black, with white text", "no timers, no CSS transitions or animations", "Pictures only as data: addresses", "no WebGL, WebAssembly or audio", "within 20 seconds", "never empty at its first, middle or last frame"]) {
        expect(c.prompt.system).toContain(said);
      }
    }
  });
});
