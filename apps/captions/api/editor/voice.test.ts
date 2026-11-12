import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MadeVoice, VoicesView } from "../../contracts/editor";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-voice-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-voice-test-secret";
process.env.ELEVENLABS_API_KEY = "";

const { createUser, newApiKey, setOff } = await import("../users");
const app = (await import("../boot")).default;
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { registerLibrarySlot, resetLibrarySlots } = await import("../library/sources");
const { saveMyKey } = await import("../my-keys");
const { MAX_VOICE_CHARS } = await import("./voice");

const cookies: Record<string, string> = {};
const keys: Record<string, string> = {};
async function login(username: string) {
  const user = createUser(username, "password1", { role: "user" });
  setOff(user, []);
  keys[username] = `Bearer ${newApiKey(user, "full")}`;
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie: cookies[user]!, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const read = async <T = { error: string }>(r: Response | Promise<Response>): Promise<{ status: number; body: T }> => {
  const res = await r;
  return { status: res.status, body: (await res.json()) as T };
};

/** ElevenLabs as the docs describe it: the voice list (v2) and text to speech (v1, audio bytes back). Every call is kept. */
const calls: { url: string; key: string; body?: unknown }[] = [];
let speech: () => Response = () => new Response(new Uint8Array([0x49, 0x44, 0x33, calls.length]), { headers: { "content-type": "audio/mpeg" } });
const elevenLabs = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("https://api.elevenlabs.io/")) throw new Error(`unexpected fetch ${url}`);
  calls.push({ url, key: new Headers(init?.headers).get("xi-api-key") ?? "", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
  if (url.includes("/v2/voices")) {
    return Response.json({
      voices: [
        { voice_id: "v_stock", name: "Sam", category: "premade", preview_url: "https://example.com/sam.mp3" },
        { voice_id: "v_mine", name: "Jordan", category: "cloned", preview_url: null },
      ],
      has_more: false,
    });
  }
  return speech();
});

beforeAll(async () => {
  for (const u of ["jordan", "nokey", "robin"]) await login(u);
  saveMyKey("jordan", "ELEVENLABS_API_KEY", "jordans-own");
  saveMyKey("robin", "ELEVENLABS_API_KEY", "robins-own");
  vi.stubGlobal("fetch", elevenLabs);
});
afterEach(() => {
  calls.length = 0;
  speech = () => new Response(new Uint8Array([0x49, 0x44, 0x33, Math.floor(Math.random() * 255), Math.floor(Math.random() * 255)]), { headers: { "content-type": "audio/mpeg" } });
});
afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(rootReplaced)("AI Editor: a voice made from text", () => {
  it("without an ElevenLabs key of their own, the answer says where to add one and nothing is asked of ElevenLabs", async () => {
    for (const r of [call("nokey", "GET", "/api/editor/voice"), call("nokey", "POST", "/api/editor/voice", { text: "Hello", voice: "Sam" })]) {
      const { status, body } = await read(r);
      expect(status).toBe(400);
      expect(body.error).toMatch(/Settings → API keys/);
    }
    expect(calls).toEqual([]);
  });

  it("lists the account's voices on its own key, its own voices first, and none used last yet", async () => {
    const { status, body } = await read<VoicesView>(call("jordan", "GET", "/api/editor/voice"));
    expect(status).toBe(200);
    expect(body).toEqual({ voices: [{ id: "v_mine", name: "Jordan", own: true }, { id: "v_stock", name: "Sam", own: false, preview: "https://example.com/sam.mp3" }], last: null });
    expect(calls).toEqual([{ url: "https://api.elevenlabs.io/v2/voices?page_size=100&include_total_count=false", key: "jordans-own" }]);
  });

  it("with no voice named and none used before, asks which, naming them; a name nobody has is answered the same way", async () => {
    const none = await read(call("jordan", "POST", "/api/editor/voice", { text: "Roll the mat out." }));
    expect(none).toEqual({ status: 400, body: { error: "Which voice? Give voice: Jordan (your own), Sam." } });
    const wrong = await read(call("jordan", "POST", "/api/editor/voice", { text: "Roll the mat out.", voice: "Robin" }));
    expect(wrong.body.error).toBe("No voice called “Robin”. Give voice: Jordan (your own), Sam.");
    expect(calls.some((c) => c.url.includes("text-to-speech"))).toBe(false);
  });

  it("speaks the text in the voice named, saves the recording in the library as a take, and remembers the voice", async () => {
    const { status, body } = await read<MadeVoice>(call("jordan", "POST", "/api/editor/voice", { text: "  Roll the mat out. Then the ramp goes down, slowly, onto the floor.  ", voice: "jordan" }));
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: "Voice: Roll the mat out. Then the ramp", voice: { id: "v_mine", name: "Jordan" } });
    const said = calls.find((c) => c.url.includes("text-to-speech"))!;
    expect(said).toEqual({ url: "https://api.elevenlabs.io/v1/text-to-speech/v_mine", key: "jordans-own", body: { text: "Roll the mat out. Then the ramp goes down, slowly, onto the floor." } });
    const row = libraryDb().prepare("SELECT a.kind, a.title, a.filed_roll, a.created_by, v.id FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.id = ?").get(body.assetId);
    expect(row).toMatchObject({ kind: "audio", title: "Voice: Roll the mat out. Then the ramp", filed_roll: null, created_by: "jordan", id: body.versionId });
    // the recording is a source an edit takes
    const edit = await read(call("jordan", "POST", "/api/editor", { sources: [body.versionId], script: "Roll the mat out." }));
    expect(edit.status).toBe(200);
    // the voice used last: listed as such, and used when none is named
    expect((await read<VoicesView>(call("jordan", "GET", "/api/editor/voice"))).body.last).toBe("v_mine");
    calls.length = 0;
    const again = await read<MadeVoice>(call("jordan", "POST", "/api/editor/voice", { text: "Try it today.", name: "Outro" }));
    expect(again.body).toMatchObject({ name: "Outro", voice: { id: "v_mine" } });
    expect(calls.find((c) => c.url.includes("text-to-speech"))!.url).toMatch(/\/v_mine$/);
  });

  it("refuses no text and a text over the limit before anything is spent", async () => {
    expect((await read(call("jordan", "POST", "/api/editor/voice", { text: "   ", voice: "Sam" }))).body.error).toBe("Give the text the voice says.");
    const long = await read(call("jordan", "POST", "/api/editor/voice", { text: "a".repeat(MAX_VOICE_CHARS + 1), voice: "Sam" }));
    expect(long.status).toBe(400);
    expect(long.body.error).toMatch(/^The text is 5,001 characters, and one voice recording takes up to 5,000/);
    expect(calls).toEqual([]);
  });

  it("says in words when ElevenLabs refuses the key, is out of credits, or is busy", async () => {
    speech = () => Response.json({ detail: { status: "missing_permissions", message: "The API key you used is missing the permission text_to_speech" } }, { status: 401 });
    expect((await read(call("jordan", "POST", "/api/editor/voice", { text: "Hello", voice: "Sam" }))).body.error).toBe(
      "ElevenLabs refused the key (The API key you used is missing the permission text_to_speech): check it in Settings → API keys. A key limited to some features needs Text to Speech and Voices.",
    );
    speech = () => Response.json({ detail: { status: "quota_exceeded", message: "This request exceeds your quota." } }, { status: 401 });
    expect(await read(call("jordan", "POST", "/api/editor/voice", { text: "Hello", voice: "Sam" }))).toEqual({ status: 402, body: { error: "Your ElevenLabs account is out of credits: add credits at elevenlabs.io, then try again." } });
    speech = () => new Response("slow down", { status: 429 });
    expect(await read(call("jordan", "POST", "/api/editor/voice", { text: "Hello", voice: "Sam" }))).toEqual({ status: 502, body: { error: "ElevenLabs is busy: try again in a minute." } });
    expect(libraryDb().prepare("SELECT COUNT(*) AS n FROM assets WHERE title = 'Voice: Hello'").get()).toEqual({ n: 0 });
  });

  it("voice_make, the AI's tool: says what to give, names the voices to ask about, then hands over the take editor_create makes the video from", async () => {
    const rpc = async (method: string, params: unknown = {}) =>
      (await (await app.request("/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: keys.robin! }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as {
        result: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean };
      };
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await rpc("tools/call", { name, arguments: args })).result;
      const text = r.content![0]!.text;
      return { error: !!r.isError, text, value: r.isError || !/^[[{]/.test(text) ? null : (JSON.parse(text) as Record<string, string>) };
    };
    expect((await rpc("tools/list")).result.tools!.map((t) => t.name)).toContain("voice_make");
    expect(await tool("voice_make")).toMatchObject({ error: true, text: "Give text: what the voice says." });
    expect(await tool("voice_make", { text: "Roll the mat out." })).toMatchObject({ error: true, text: "Which voice? Give voice: Jordan (your own), Sam." });
    expect(calls.some((c) => c.url.includes("text-to-speech"))).toBe(false);

    const made = await tool("voice_make", { text: "Roll the mat out.", voice: "Sam", name: "Tiny Acrobatics mat" });
    expect(made.error).toBe(false);
    expect(made.value).toMatchObject({ name: "Tiny Acrobatics mat", voice: "Sam", next: expect.stringContaining("editor_create") });
    expect(made.value!.link).toMatch(/\/library\?library=[^&]+&asset=[^&]+$/);
    expect(calls.find((c) => c.url.includes("text-to-speech"))).toMatchObject({ url: "https://api.elevenlabs.io/v1/text-to-speech/v_stock", key: "robins-own" });
    // the take it answered is what editor_create takes as the only source
    const edit = await tool("editor_create", { sources: [made.value!.version_id], script: "Roll the mat out.", start: false });
    expect(edit.error).toBe(false);
    const e = (await (await call("robin", "GET", `/api/editor/${edit.value!.id}`)).json()) as { sources: string[]; script: string };
    expect(e).toMatchObject({ sources: [made.value!.version_id], script: "Roll the mat out." });
  });

  it("where a plug-in's source is the Media Library, says a voice has no place there, and spends nothing", async () => {
    registerLibrarySlot("tiny", { source: { id: "catalog", label: "Footage catalog", main: true } });
    try {
      expect(await read(call("jordan", "POST", "/api/editor/voice", { text: "Hello", voice: "Sam" }))).toEqual({
        status: 400,
        body: { error: "On this server the Media Library is the Footage catalog, and a voice made here has no place in it yet." },
      });
      expect(calls).toEqual([]);
    } finally {
      resetLibrarySlots();
    }
  });
});
