import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CUTOUT_KIND, EDITOR_HINT } from "../../contracts/devices";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "cutout-"));
process.env.APP_SECRET = "cutout-secret";

// the server with this plug-in built in, as scripts/plugins.mjs builds one in from plugins/cutout
vi.mock("../../api/plugins.gen", async () => ({ serverPlugins: [(await import("./plugin")).default] }));

const { createUser, newApiKey } = await import("../../api/users");
const app = (await import("../../api/boot")).default;
const { pairDevice } = await import("../../api/lib/devices");
const { saveSettings } = await import("../../api/lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");
const { handle, pluginToolsOf } = await import("../../api/mcp");

// ana's Mac app takes cut-outs, ben's is older than that, cleo has none
const ana = createUser("ana", "password1");
createUser("ben", "password1");
createUser("cleo", "password1");
const anaKey = `Bearer ${newApiKey(ana, "full")}`;
const anaMac = pairDevice("ana", "Ana's Mac");
const benMac = pairDevice("ben", "Ben's Mac");
for (const [user, mac] of [["ana", anaMac], ["ben", benMac]] as const)
  await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, user);

type Tool = { name: string; description: string; inputSchema: unknown };
const json = (body: unknown, extra: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const cookieOf = async (username: string) => (await app.request("/api/auth/login", json({ username, password: "password1" }))).headers.get("set-cookie")!.split(";")[0]!;
const as = (token: string) => ({ authorization: `Bearer ${token}` });
/** The long poll's body: this Mac app lists the cut-out, the one before it only cards, and the one before that nothing. */
const NEW = { blobs: true, editor: ["cards-draw", CUTOUT_KIND] };
const OLD = { blobs: true, editor: ["cards-draw"] };
const poll = (token: string, body: object) => app.request("/api/devices/relay/wait", json(body, as(token)));
/** A poll nothing answers is held 25 seconds and ends 204; the test's clock runs those seconds. */
async function held(token: string, body: object): Promise<number> {
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
const claim = async (token: string, kinds = NEW.editor) => ((await (await app.request("/api/devices/relay/editor/claim", json({ kinds }, as(token)))).json()) as { job: { id: number; kind: string } | null }).job;
const picture = (token: string, id: number) => app.request(`/api/devices/relay/cutout/${id}`, { headers: as(token) });
function send(token: string, id: number, bytes: Buffer) {
  const form = new FormData();
  form.append("cutout", new File([new Uint8Array(bytes)], "cutout.png", { type: "image/png" }));
  return app.request(`/api/devices/relay/cutout/${id}`, { method: "POST", headers: as(token), body: form });
}
const fail = (token: string, id: number, error: string) => app.request(`/api/devices/relay/cutout/${id}/fail`, json({ error }, as(token)));
/** A cut-out asked of the plug-in's route as an account: its answer's status and body, once the Mac is done. */
const cut = async (cookie: string, body: object) => {
  const r = await app.request("/api/x/cutout", json(body, { cookie }));
  return { status: r.status, body: (await r.json()) as { error?: string; href?: string; bytes?: number } };
};
/** A picture as the server sees one: it reads only the first bytes. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (size: number, fill = 1) => Buffer.concat([PNG, Buffer.alloc(size - 8, fill)]);
const data = (b: Buffer) => ({ data: b.toString("base64") });
const tick = () => new Promise((r) => setTimeout(r, 100));

/** A reply of `user`'s, its job taken by their Mac's poll: the token to call tools as that reply, and its prompt. */
async function reply(user: string, mac: { token: string }, body: object, text: string, images?: object[]) {
  expect((await app.request("/api/assistant/turn", json({ text, ...(images ? { images } : {}) }, { cookie: await cookieOf(user) }))).status).toBe(202);
  const job = (await (await poll(mac.token, body)).json()) as { id: string; system: string; user: string; mcp: { token: string } };
  const rpc = async (method: string, params: object) =>
    ((await (await app.request("/api/mcp", json({ jsonrpc: "2.0", id: 1, method, params }, { authorization: `Bearer ${job.mcp.token}` }))).json()) as { result: { tools?: Tool[]; content?: Array<{ text: string }>; isError?: boolean } }).result;
  return { job, rpc, end: () => app.request(`/api/devices/relay/${job.id}/done`, json({ text: "Done." }, as(mac.token))) };
}

describe("the cut-out plug-in", () => {
  it("adds its one tool to the list, in the dock and on an outside AI key, and nothing to the prompt", async () => {
    const golden = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../api/golden/assistant-no-style.json"), "utf8")) as { system: string; user: string };
    const r = await reply("ana", anaMac, {}, "What can you do?");
    // the list as the server sends it (the plug-in in), and the same call answered with no plug-in
    const call = (p: string, init?: RequestInit) => Promise.resolve(app.request(p, init));
    const bare = async (authorization: string) =>
      ((await handle(call, new Headers({ authorization }), { jsonrpc: "2.0", id: 1, method: "tools/list" }, "http://127.0.0.1", ana, pluginToolsOf([]))) as { result: { tools: Tool[] } }).result.tools;
    const listed = async (authorization: string) => ((await (await app.request("/api/mcp", json({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { authorization }))).json()) as { result: { tools: Tool[] } }).result.tools;
    const job = `Bearer ${r.job.mcp.token}`;
    const [dock, dockBare, outside, outsideBare] = await Promise.all([listed(job), bare(job), listed(anaKey), bare(anaKey)]);
    await r.end();
    // the prompt is main's character for character: the plug-in brings no guide
    expect(r.job.system).toBe(golden.system);
    expect(r.job.user).toBe(golden.user);
    // every other tool as it is without the plug-in, and the plug-in's one last, the same for both callers
    expect(JSON.stringify(dock.slice(0, -1))).toBe(JSON.stringify(dockBare));
    expect(JSON.stringify(outside.slice(0, -1))).toBe(JSON.stringify(outsideBare));
    const def = dock.at(-1)!;
    expect(def.name).toBe("picture_cutout");
    expect(outside.at(-1)).toEqual(def);
    // what every turn now carries with the plug-in on: the definition, and the comma before it
    expect(Buffer.byteLength(def.description)).toBe(176);
    expect(Buffer.byteLength(JSON.stringify(dock)) - Buffer.byteLength(JSON.stringify(dockBare))).toBe(319);
  });

  it("cuts out a picture of the chat on the person's own Mac, told on the poll it holds, and only its owner reads the result", async () => {
    expect(await held(anaMac.token, NEW)).toBe(204);   // ana's Mac app is on and lists the cut-out
    const photo = png(5000, 7);
    const r = await reply("ana", anaMac, NEW, "Cut the ball out of this", [{ name: "ball.png", type: "image/png", data: photo.toString("base64") }]);
    expect(r.job.user).toContain("attached/01-ball.png");
    // the Mac holds its next poll while the AI works: the cut-out is said on it at once
    const told = poll(anaMac.token, NEW);
    await tick();
    const called = r.rpc("tools/call", { name: "picture_cutout", arguments: { picture: "attached/01-ball.png" } });
    expect(await (await told).json()).toEqual(EDITOR_HINT);
    const step = (await claim(anaMac.token))!;
    expect(step.kind).toBe(CUTOUT_KIND);
    const got = await picture(anaMac.token, step.id);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await got.arrayBuffer()).equals(photo)).toBe(true);
    const made = png(3000, 9);
    expect(await (await send(anaMac.token, step.id, made)).json()).toEqual({ ok: true });
    const out = await called;
    expect(out.isError).toBeFalsy();
    const { said, href } = JSON.parse(out.content![0]!.text) as { said: string; href: string };
    expect(said).toBe(`Cut out: put ![Cut-out](${href}) in your reply to show it.`);
    expect(href).toMatch(/^\/api\/x\/cutout\/[0-9a-f-]{36}\.png$/);
    const mine = await app.request(href, { headers: { cookie: await cookieOf("ana") } });
    expect(mine.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await mine.arrayBuffer()).equals(made)).toBe(true);
    expect((await app.request(href, { headers: { cookie: await cookieOf("cleo") } })).status).toBe(404);
    // a name the reply's message has no picture for
    const none = await r.rpc("tools/call", { name: "picture_cutout", arguments: { picture: "attached/02-ball.png" } });
    expect([none.isError, none.content![0]!.text]).toEqual([true, "attached/02-ball.png isn't a picture of the message you are answering: ask for it again."]);
    await r.end();
  });

  it("says what is missing in the app's words: a Mac, or a Mac app new enough", async () => {
    const cleo = await cut(await cookieOf("cleo"), data(png(100)));
    expect(cleo).toEqual({ status: 409, body: { error: "Needs a Mac with Creator Toolset on" } });
    // ben's Mac app is on and answers his assistant, but lists no cut-out
    const r = await reply("ben", benMac, OLD, "Cut this out", [{ name: "cup.png", type: "image/png", data: png(100).toString("base64") }]);
    const out = await r.rpc("tools/call", { name: "picture_cutout", arguments: { picture: "attached/01-cup.png" } });
    expect([out.isError, out.content![0]!.text]).toEqual([true, "Needs the newest Creator Toolset Mac app"]);
    await r.end();
  });

  it("is never said to or handed to a Mac app older than the cut-out, nor to another account's Mac", async () => {
    const oldMac = pairDevice("ana", "Ana's other Mac");
    const cookie = await cookieOf("ana");
    const asked = cut(cookie, data(png(100)));
    await tick();
    expect(await held(oldMac.token, OLD)).toBe(204);
    expect(await claim(oldMac.token, OLD.editor)).toBeNull();
    expect(await held(oldMac.token, {})).toBe(204);
    expect(await claim(benMac.token)).toBeNull();
    const step = (await claim(anaMac.token))!;
    // another account's Mac reads nothing of it and can't end it
    expect((await picture(benMac.token, step.id)).status).toBe(404);
    expect((await send(benMac.token, step.id, png(100))).status).toBe(404);
    expect(await (await fail(benMac.token, step.id, "no")).json()).toEqual({ ok: false });
    expect(await (await fail(anaMac.token, step.id, "Nothing in this picture stands out from its background.")).json()).toEqual({ ok: true });
    expect(await asked).toEqual({ status: 409, body: { error: "Nothing in this picture stands out from its background." } });
  });

  it("holds each cap: the picture's bytes, what it is, how many wait, the PNG's bytes and the time", async () => {
    const cookie = await cookieOf("ana");
    expect(await cut(cookie, data(png(25_000_001)))).toEqual({ status: 409, body: { error: "The picture is over 25 MB." } });
    for (const not of ["GIF89a, a moving picture", "RIFF0000WEBPVP8 , a WebP", "Tiny Acrobatics"])
      expect(await cut(cookie, data(Buffer.from(not)))).toEqual({ status: 409, body: { error: "That is not a PNG, JPEG or HEIC picture." } });
    expect(await cut(cookie, {})).toEqual({ status: 409, body: { error: "Send the picture: data (base64) or path." } });

    // five wait at most; the one at the cap (exactly 25 MB) is taken
    const five = [cut(cookie, data(png(25_000_000))), ...[1, 2, 3, 4].map(() => cut(cookie, data(png(100))))];
    await tick();
    expect(await cut(cookie, data(png(100)))).toEqual({ status: 409, body: { error: "5 pictures are being cut out already: wait for one of them." } });
    const steps = [];
    for (let i = 0; i < 5; i++) steps.push((await claim(anaMac.token))!);
    expect((await (await picture(anaMac.token, steps[0]!.id)).arrayBuffer()).byteLength).toBe(25_000_000);
    // the PNG the Mac sends: up to 40 MB, and a PNG
    expect(await (await send(anaMac.token, steps[0]!.id, png(40_000_000))).json()).toEqual({ ok: true });
    const over = await send(anaMac.token, steps[1]!.id, png(40_000_001));
    expect([over.status, await over.json()]).toEqual([400, { error: "The cut-out is over 40 MB." }]);
    const jpeg = await send(anaMac.token, steps[2]!.id, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
    expect([jpeg.status, await jpeg.json()]).toEqual([400, { error: "Your Mac sent no PNG." }]);
    for (const s of steps.slice(3)) await fail(anaMac.token, s.id, "Stopped.");
    const ends = await Promise.all(five);
    expect(ends.map((e) => e.body.error ?? e.body.bytes)).toEqual([40_000_000, "The cut-out is over 40 MB.", "Your Mac sent no PNG.", "Stopped.", "Stopped."]);

    // a Mac that never answers: the cut-out fails at 45 s, not before
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let ended: { status: number; body: { error?: string } } | undefined;
      void cut(cookie, data(png(100))).then((e) => (ended = e));
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      expect(await claim(anaMac.token)).toMatchObject({ kind: CUTOUT_KIND });
      await vi.advanceTimersByTimeAsync(44_999);
      expect(ended).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      for (let i = 0; i < 20 && !ended; i++) await new Promise((r) => setImmediate(r));
      expect(ended).toEqual({ status: 409, body: { error: "Your Mac did not cut the picture out in 45 seconds." } });
    } finally {
      vi.useRealTimers();
    }
    // about 100 MB of pictures go through the routes: room for a loaded machine
  }, 30_000);

  it("takes a file on this computer by its path only when the server runs there", async () => {
    const cookie = await cookieOf("ana");
    const file = path.join(process.env.DATA_DIR!, "cup.heic");
    writeFileSync(file, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(200)]));
    expect(await cut(cookie, { path: file })).toEqual({ status: 409, body: { error: "This server isn't on your computer: send the picture in the chat." } });
    process.env.CT_LOCAL = "1";
    try {
      expect((await cut(cookie, { path: "cup.heic" })).body.error).toBe("Give the picture's full path, such as /Users/you/Pictures/photo.heic.");
      const asked = cut(cookie, { path: file });
      await tick();
      const step = (await claim(anaMac.token))!;
      expect((await picture(anaMac.token, step.id)).headers.get("content-type")).toBe("image/heic");
      await send(anaMac.token, step.id, png(64));
      expect((await asked).body.bytes).toBe(64);
    } finally {
      delete process.env.CT_LOCAL;
    }
  });
});
