import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";
import type { SessionUser } from "./users";

const dir = mkdtempSync(path.join(tmpdir(), "local-model-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "test-secret-123"; // accounts on; boots the "admin" account
const { aiFor, completeWithFallback, streamWithFallback } = await import("./ai-complete");
const { completeVisionWithFallback } = await import("./ai-vision");
const { hedgeAfter } = await import("./lib/cadence-lines");
const { macUsageSince } = await import("./lib/mac-claude");
const { scriptCheckOpts } = await import("./lib/script-check");
const { addressOf, fewestTokens, localModelOf } = await import("./local-model");
const { myKeysApp, saveMyKey } = await import("./my-keys");
const { createUser, findUser, setRole } = await import("./users");
createUser("lee", "password1");
createUser("sam", "password1", { role: "admin" });

/**
 * A model server on this machine, standing in for the person's own: it lists two models and answers the Messages
 * request the way one does. Every request it gets is kept, so a test reads what was really sent.
 */
type Got = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
const got: Got[] = [];
let answer: (req: Got) => { status: number; body: unknown } = () => ({ status: 200, body: { content: [{ type: "text", text: "from the local model" }], usage: { input_tokens: 40, output_tokens: 2 } } });
// POST /api/chat, the question asked before each request (tooLongFor): by default this server has no such route
const noSuchRoute = () => ({ status: 404, body: { error: "not found" } });
let fits: (req: Got) => { status: number; body: unknown } = noSuchRoute;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
    got.push(seen);
    const out = req.url === "/v1/models" ? { status: 200, body: { object: "list", data: [{ id: "small-one" }, { id: "big-one:12b" }] } } : req.url === "/api/chat" ? fits(seen) : answer(seen);
    res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
  });
});
let address = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const admin: SessionUser = { username: "admin", role: "admin", cloud: true, off: [] };
const lee: SessionUser = { username: "lee", role: "user", cloud: true, off: [] };
const sam: SessionUser = { username: "sam", role: "admin", cloud: true, off: [] };
/** Settings → API keys as `who`: the page's own routes (my-keys.ts mounts the Local model box). */
const as = (who: SessionUser) => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => (c.set("user", who), next()));
  app.route("/", myKeysApp);
  return {
    get: (p = "") => app.request(`/local-model${p}`),
    put: (body: unknown) => app.request("/local-model", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
};
const key = ["not", "a", "real", "key"].join("-");
/** The requests themselves, without the question before each. */
const sent = () => got.filter((g) => g.url === "/v1/messages");
const noAi = { only: [], off: "No AI for your account: add one in Settings → Providers, or your Anthropic key in Settings → API keys" };

afterEach(async () => {
  vi.unstubAllEnvs(); // first: while a test's CT_MODE=hosted is still set, the box refuses to be cleared
  await as(admin).put({ url: null });
  saveMyKey("admin", "ANTHROPIC_API_KEY", null);
  got.length = 0;
  fits = noSuchRoute;
  answer = () => ({ status: 200, body: { content: [{ type: "text", text: "from the local model" }], usage: { input_tokens: 40, output_tokens: 2 } } });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("who may set a local model", () => {
  it("a hosted server refuses the routes, an admin's too, and does not read a file saved before", async () => {
    expect((await as(admin).put({ url: address, model: "small-one" })).status).toBe(200);
    expect(aiFor(admin, "captions", "Caption Studio").only).toEqual(["localModel"]);
    vi.stubEnv("CT_MODE", "hosted");
    for (const r of [await as(admin).get(), await as(admin).get(`/models?url=${encodeURIComponent(address)}`), await as(admin).put({ url: address, model: "small-one" }), await as(admin).put({ url: null })])
      expect(r.status).toBe(403);
    expect(got).toEqual([]); // no request left for the typed address
    expect(existsSync(path.join(dir, "local-model", "admin.json"))).toBe(true); // the refused "forget it" changed nothing
    // the file is still there, and the account is routed as if it were not: the same answer as origin/main
    expect(localModelOf("admin")).toBeNull();
    expect(aiFor(admin, "captions", "Caption Studio")).toEqual(noAi);
    saveMyKey("admin", "ANTHROPIC_API_KEY", key);
    expect(aiFor(admin, "captions", "Caption Studio")).toEqual({ only: ["anthropic"], retries: 1, apiKey: key, mac: { label: "Caption Studio" } });
  });

  it("on an own install a member cannot set one, or have the server ask an address for its models", async () => {
    for (const r of [await as(lee).get(), await as(lee).get(`/models?url=${encodeURIComponent(address)}`), await as(lee).put({ url: address, model: "small-one" })])
      expect(r.status).toBe(403);
    expect(got).toEqual([]);
    expect(existsSync(path.join(dir, "local-model", "lee.json"))).toBe(false);
    expect(aiFor(lee, "captions", "Caption Studio")).toEqual(noAi);
    // nor a share-link visitor (the page's own gate)
    expect((await as({ username: "visitor", role: "visitor", cloud: false, off: [] }).put({ url: address, model: "small-one" })).status).toBe(403);
  });

  it("an admin who stops being one loses it at the next call, with the file still saved", async () => {
    expect((await as(sam).put({ url: address, model: "small-one" })).status).toBe(200);
    expect(aiFor("sam", "notes", "Video Notes")).toEqual({ only: ["localModel"], localModel: { url: address, model: "small-one" }, mac: { label: "Video Notes" } });
    setRole(findUser("sam")!, "user");
    expect(localModelOf("sam")).toBeNull();
    expect(aiFor("sam", "notes", "Video Notes")).toEqual(noAi);
  });

  it("an admin saves an address and a model, reads them back and forgets them", async () => {
    expect(await (await as(admin).get()).json()).toEqual({});
    const saved = await as(admin).put({ url: `${address}/v1/`, model: " big-one:12b " });
    expect(await saved.json()).toEqual({ url: address, model: "big-one:12b" });
    expect(await (await as(admin).get()).json()).toEqual({ url: address, model: "big-one:12b" });
    expect((await as(admin).put({ url: null })).status).toBe(200);
    expect(await (await as(admin).get()).json()).toEqual({});
    expect(aiFor(admin, "captions", "Caption Studio")).toEqual(noAi);
  });

  it("refuses what is not an http address, an address with a sign-in in it, and a missing model name", async () => {
    for (const body of [{ url: "ftp://files.example/x", model: "m" }, { url: "http://someone:secret@model.example", model: "m" }, { url: "http://model.example/?to=elsewhere", model: "m" }, { url: "", model: "m" }, { model: "m" }, { url: address }, { url: address, model: "" }, { url: address, model: "two words" }])
      expect((await as(admin).put(body)).status).toBe(400);
    expect(await (await as(admin).get()).json()).toEqual({});
    expect(addressOf("localhost:11434")).toBe("http://localhost:11434");
    expect(addressOf("https://model.example/base/v1")).toBe("https://model.example/base");
    expect(addressOf("file:///etc/passwd")).toBeNull();
  });

  it("offers the models the address lists, and none when it does not answer", async () => {
    expect(await (await as(admin).get(`/models?url=${encodeURIComponent(address)}`)).json()).toEqual({ models: ["small-one", "big-one:12b"] });
    expect(got.map((g) => `${g.method} ${g.url}`)).toEqual(["GET /v1/models"]);
    expect(await (await as(admin).get(`/models?url=${encodeURIComponent("http://127.0.0.1:9")}`)).json()).toEqual({ models: [] });
    expect(await (await as(admin).get("/models?url=nonsense%20here")).json()).toEqual({ models: [] });
    expect(await (await as(admin).get("/models")).json()).toEqual({ models: [] });
  });
});

describe("what a local model is sent, and what it never is", () => {
  it("the same Messages request, to the typed address: no key, no output_config, thinking off, the prompt untouched", async () => {
    saveMyKey("admin", "ANTHROPIC_API_KEY", key); // a key is saved too: the local model answers, and never sees it
    vi.stubEnv("ANTHROPIC_API_KEY", "the-servers-own-key");
    await as(admin).put({ url: address, model: "big-one:12b" });
    const route = aiFor(admin, "captions", "Caption Studio");
    expect(route).toEqual({ only: ["localModel"], localModel: { url: address, model: "big-one:12b" }, mac: { label: "Caption Studio" } });
    const everywhere = vi.spyOn(globalThis, "fetch");
    expect(await completeWithFallback("The system text", "The user text", undefined, (t) => t, route)).toBe("from the local model");
    // the question and the request, both to the typed address, and nothing to Anthropic
    expect(everywhere.mock.calls.map((c) => String(c[0]))).toEqual([`${address}/api/chat`, `${address}/v1/messages`]);
    expect(got.map((g) => `${g.method} ${g.url}`)).toEqual(["POST /api/chat", "POST /v1/messages"]);
    // the question: the same system and user text, thinking off, one token of answer, told not to cut
    expect(got[0].body).toBe('{"model":"big-one:12b","stream":false,"think":false,"truncate":false,"options":{"num_predict":1},"messages":[{"role":"system","content":"The system text"},{"role":"user","content":"The user text"}]}');
    got.shift();
    // thinking off: the format's own field, where the Anthropic request has output_config
    expect(got[0].body).toBe('{"model":"big-one:12b","max_tokens":16000,"thinking":{"type":"disabled"},"system":"The system text","messages":[{"role":"user","content":"The user text"}]}');
    expect(got[0].body).not.toContain("output_config");
    expect(got[0].headers).not.toHaveProperty("x-api-key");
    expect(got[0].headers).not.toHaveProperty("authorization");
    // neither key, in neither of the two
    expect(everywhere.mock.calls.map((c) => JSON.stringify(c[1]?.headers)).join()).not.toMatch(/api-key|authorization/i);
    expect(everywhere.mock.calls.map((c) => JSON.stringify(c[1])).join()).not.toContain(key);
    expect(everywhere.mock.calls.map((c) => JSON.stringify(c[1])).join()).not.toContain("the-servers-own-key");
    expect(JSON.stringify(got[0])).not.toContain(key);
    expect(JSON.stringify(got[0])).not.toContain("the-servers-own-key");
    expect(got[0].headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("a streamed call gets the same request and the answer in one piece", async () => {
    await as(admin).put({ url: address, model: "small-one" });
    const deltas: string[] = [];
    const out = await streamWithFallback("sys", "user", undefined, (t) => t, { onDelta: (t) => void deltas.push(t) }, aiFor(admin, "notes", "Video Notes"));
    expect(out).toEqual({ result: "from the local model", provider: "Local model" });
    expect(deltas).toEqual(["from the local model"]);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].body).toBe('{"model":"small-one","max_tokens":16000,"thinking":{"type":"disabled"},"system":"sys","messages":[{"role":"user","content":"user"}]}');
    for (const g of got) expect(g.headers).not.toHaveProperty("x-api-key");
  });

  it("never the Workshop, which reads a folder a plain request can't", async () => {
    await as(admin).put({ url: address, model: "small-one" });
    expect(aiFor(admin, "workshop", "Workshop")).toEqual({ only: [], off: "Content Workshop runs on your own AI (it reads the whole project folder): connect yours in Settings → Providers" });
  });

  it("pictures never go to the local address: the account's key reads them, or the call says what to add", async () => {
    await as(admin).put({ url: address, model: "small-one" });
    const picture = [{ jpegBase64: "AAAA" }];
    await expect(completeVisionWithFallback("sys", "what is this", picture, undefined, (t) => t, admin)).rejects.toThrow("A local model answers text only");
    expect(got).toEqual([]);
    saveMyKey("admin", "ANTHROPIC_API_KEY", key);
    vi.stubEnv("ANTHROPIC_BASE_URL", "");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "a picture" }] }), { status: 200 }));
    expect(await completeVisionWithFallback("sys", "what is this", picture, undefined, (t) => t, admin)).toEqual({ value: "a picture", provider: "anthropic" });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.anthropic.com/v1/messages");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(got).toEqual([]);
  });
});

describe("a local model that fails", () => {
  it("down: the call fails with the address in the message, and the saved Anthropic key is never spent instead", async () => {
    saveMyKey("admin", "ANTHROPIC_API_KEY", key);
    const gone = "http://127.0.0.1:9"; // nothing listens here
    await as(admin).put({ url: gone, model: "small-one" });
    const everywhere = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(completeWithFallback("sys", "user", undefined, (t) => t, aiFor(admin, "captions", "Caption Studio"))).rejects.toMatchObject({
      message: `The local model at ${gone} did not answer: check that it is running`,
      code: "FAILED",
      retryable: false,
    });
    await expect(streamWithFallback("sys", "user", undefined, (t) => t, {}, aiFor(admin, "captions", "Caption Studio"))).rejects.toThrow(`The local model at ${gone} did not answer`);
    // two calls, the question and one request each (no retry), all to the local address
    expect(everywhere.mock.calls.map((c) => String(c[0]))).toEqual([`${gone}/api/chat`, `${gone}/v1/messages`, `${gone}/api/chat`, `${gone}/v1/messages`]);
  });

  it("a model the server does not have: its own words, not a message about an API key or credits", async () => {
    await as(admin).put({ url: address, model: "not-installed" });
    answer = () => ({ status: 404, body: { type: "error", error: { type: "not_found_error", message: "model 'not-installed' not found" } } });
    await expect(completeWithFallback("sys", "user", undefined, (t) => t, aiFor(admin, "captions", "Caption Studio"))).rejects.toThrow(
      `The local model at ${address} answered 404: model 'not-installed' not found`,
    );
    for (const status of [401, 402, 429]) {
      answer = () => ({ status, body: { error: { message: "no" } } });
      const e = (await completeWithFallback("sys", "user", undefined, (t) => t, aiFor(admin, "captions", "Caption Studio")).catch((x: unknown) => x)) as Error & { code: string };
      expect(e.message).toBe(`The local model at ${address} answered ${status}: no`);
      expect(e.code).toBe("FAILED");
    }
    expect(sent()).toHaveLength(4); // one request per call
  });

  it("an answer cut off for lack of room says so, with the numbers, instead of passing half an answer on", async () => {
    await as(admin).put({ url: address, model: "small-one" });
    // a model that thinks first, on a short context: no text at all
    answer = () => ({ status: 200, body: { content: [{ type: "thinking", thinking: "First, the task" }], stop_reason: "max_tokens", usage: { input_tokens: 1225, output_tokens: 2870 } } });
    const why = `The local model at ${address} ran out of room before it finished (1225 tokens in, 2870 out): give it a longer context on its server`;
    await expect(completeWithFallback("sys", "user", undefined, (t) => t, aiFor(admin, "captions", "Caption Studio"))).rejects.toThrow(why);
    // or half the lines
    answer = () => ({ status: 200, body: { content: [{ type: "text", text: '{"lines": ["So here' }], stop_reason: "max_tokens", usage: { input_tokens: 1225, output_tokens: 2870 } } });
    await expect(completeWithFallback("sys", "user", undefined, (t) => t, aiFor(admin, "captions", "Caption Studio"))).rejects.toThrow(why);
    expect(sent()).toHaveLength(2);
  });

  it("an answer that does not parse is not retried anywhere either", async () => {
    saveMyKey("admin", "ANTHROPIC_API_KEY", key);
    await as(admin).put({ url: address, model: "small-one" });
    const everywhere = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(completeWithFallback("sys", "user", undefined, () => { throw new Error("The model returned no JSON"); }, aiFor(admin, "captions", "Caption Studio"))).rejects.toThrow("The model returned no JSON");
    expect(everywhere.mock.calls.map((c) => String(c[0]))).toEqual([`${address}/api/chat`, `${address}/v1/messages`]);
  });

  it("a Stop reaches the request and reads as stopped", async () => {
    await as(admin).put({ url: address, model: "small-one" });
    const stop = new AbortController();
    stop.abort();
    await expect(completeWithFallback("sys", "user", stop.signal, (t) => t, aiFor(admin, "captions", "Caption Studio"))).rejects.toMatchObject({ code: "ABORTED" });
  });
});

describe("a local model costs nothing", () => {
  it("its tokens are passed on at no price, whatever it is called, and nothing is tallied as paid", async () => {
    // named like the one model the price table knows: still free
    for (const model of ["claude-opus-5-5", "a-name-no-table-has"]) {
      await as(admin).put({ url: address, model });
      const onUsage = vi.fn();
      await completeWithFallback("sys", "user", undefined, (t) => t, { ...aiFor(admin, "captions", "Costs nothing"), onUsage });
      expect(onUsage.mock.calls).toEqual([[{ tokens: 42, costUsd: 0 }]]);
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(Object.values(await macUsageSince(Date.now() - 3_600_000)).flatMap((h) => Object.keys(h)).filter((l) => l.startsWith("Costs nothing"))).toEqual([]);
  });
});

describe("one request at a time", () => {
  it("a second request to the same address waits for the first, so each has its own time limit", async () => {
    await as(admin).put({ url: address, model: "small-one" });
    let inFlight = 0;
    let most = 0;
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...a: Parameters<typeof fetch>) => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      try {
        return await real(...a);
      } finally {
        inFlight--;
      }
    });
    const route = aiFor(admin, "captions", "Caption Studio");
    const answers = await Promise.all([1, 2, 3].map(() => completeWithFallback("sys", "user", undefined, (t) => t, route)));
    expect(answers).toEqual(Array(3).fill("from the local model"));
    expect(most).toBe(1);
  });

  it("no hedged second request: it would only double the model's work", async () => {
    await as(admin).put({ url: address, model: "small-one" });
    const route = aiFor(admin, "captions", "Caption Studio");
    expect(hedgeAfter({ provider: route })).toBe(15 * 60_000);
    expect(scriptCheckOpts(admin, {}).hedgeAfterMs).toBe(15 * 60_000);
    // an account on its key keeps the hedge it has
    await as(admin).put({ url: null });
    saveMyKey("admin", "ANTHROPIC_API_KEY", key);
    expect(hedgeAfter({ provider: aiFor(admin, "captions", "Caption Studio") })).toBe(40_000);
    expect(scriptCheckOpts(admin, {})).not.toHaveProperty("hedgeAfterMs");
  });
});

/* ---- a prompt longer than the model server's context is cut without a word: the count it read is the one sign ---- */

// Made-up text of different kinds, and the tokens one model server counted for each whole request ("Answer briefly."
// + the text + the ask) on two models. Kept as data, so the bound is held against what was measured, not against a guess.
const times = (s: string, n: number) => Array.from({ length: n }, (_, i) => s.replace(/\bN\b/g, String(i + 1))).join(" ");

const english = `So I rebuilt the whole morning routine for our little studio, and honestly, it changed everything. The first thing we do now is open the windows, every single day, even when it is cold outside. Then we roll out the mats, the big blue ones, and we check each corner, because a mat that slides is a mat nobody trusts. After that, the music goes on, quietly, something slow, something with no words in it. And here is the part people skip. We sit down for two minutes and do nothing. No phones, no talking, just breathing, in and out, until the room feels calm. Why does that matter? Because the first class of the day copies the mood of the room, and if we are rushed, they are rushed. Next, we set out the small things, the soft blocks, the rings, the little balance beam that everyone loves. We count them, twice, and we write the number on the board. If one is missing at the end, we know right away. Then comes my favourite step. We walk the whole floor, slowly, like a visitor would, and we ask one question: what would I trip over? Usually it is a bag, or a bottle, or a cable from the speaker. We move it, and we move on.`;
const numbers = times(`At 14:32 on 2026-11-08 we logged 1,284 visits and 317 sign-ups in run N; batch 000417-A cost $18,945.50, or 14.75 per unit, up 3.2% from 18,357.25. Call +1 (555) 010-4477 about order 77-3391-0042, version 12.4.118, serial 9A4F-22C1-7731, between 09:15 and 17:45.`, 6);
const russian = times(`Каждое утро мы открываем окна в нашей маленькой студии, даже когда на улице холодно. Потом раскатываем большие синие маты и проверяем каждый угол, потому что мату, который скользит, никто не доверяет. После этого тихо включаем медленную музыку без слов и две минуты просто дышим.`, 5);
const japanese = times(`毎朝、私たちは小さなスタジオの窓を開けます。外が寒い日でも同じです。それから大きな青いマットを広げて、四隅を一つずつ確かめます。滑るマットは誰にも信頼されないからです。そのあと、言葉のないゆっくりした音楽を静かに流して、二分間ただ呼吸をします。`, 6);
const chinese = times(`每天早上，我们都会打开小工作室的窗户，即使外面很冷也一样。然后铺开蓝色的大垫子，逐个检查每个角，因为会滑动的垫子没有人信任。之后我们轻轻放一段没有歌词的慢音乐，安静地呼吸两分钟，直到整个房间平静下来。`, 8);
const estonian = times(`Igal hommikul avame oma väikese stuudio aknad, isegi siis, kui väljas on külm. Seejärel rullime lahti suured sinised matid ja kontrollime iga nurka, sest libisevat matti ei usalda keegi. Pärast seda paneme vaikselt mängima aeglase sõnadeta muusika ja hingame kaks minutit rahulikult.`, 5);
const arabic = times(`كل صباح نفتح نوافذ الاستوديو الصغير حتى عندما يكون الجو باردا في الخارج. ثم نفرش الحصائر الزرقاء الكبيرة ونتحقق من كل زاوية لأن الحصيرة التي تنزلق لا يثق بها أحد. بعد ذلك نشغل موسيقى هادئة بلا كلمات ونتنفس بهدوء لمدة دقيقتين.`, 6);
const sentences = english.split(/(?<=[.?])\s+/).map((text, i) => ({ i, src: `take-${(i % 3) + 1}`, start: +(i * 3.41).toFixed(2), end: +(i * 3.41 + 2.87).toFixed(2), text, keep: i % 4 !== 0 }));
const table = Array.from({ length: 60 }, (_, i) => `${`item-${i + 1}`.padEnd(24)}${String((i * 7.5 + 12).toFixed(2)).padStart(12)}${"ok".padStart(16)}`).join("\n");
const ask = "\n\nReply with the single word OK.";
// the editor's script step lists sentences as "number source seconds text"
const editorLines = `Sentences (number, source, seconds, text):\n${[...sentences, ...sentences, ...sentences].map((s, n) => `${n + 1} S${(n % 3) + 1} ${(n * 3.41).toFixed(1)}-${(n * 3.41 + 2.87).toFixed(1)} ${s.text}`).join("\n")}`;
const measured: Array<[name: string, text: string, characters: number, counted: [number, number]]> = [
  ["english", english, 1173, [294, 293]], // 4.0 characters a token
  ["numbers", numbers, 1624, [1031, 1018]], // 1.6
  ["estonian", estonian, 1466, [464, 478]], // 3.1
  ["russian", russian, 1446, [389, 369]], // 3.7 to 3.9
  ["arabic", arabic, 1402, [515, 454]], // 2.7 to 3.1
  ["japanese", japanese, 784, [448, 429]], // 1.8
  ["chinese", chinese, 854, [564, 507]], // 1.5 to 1.7
  ["json", JSON.stringify(sentences), 2293, [818, 803]], // 2.8
  ["indented json", JSON.stringify(sentences, null, 2), 2966, [1251, 1250]], // 2.4
  ["padded table", table, 3226, [847, 906]], // 3.6 to 3.8
  ["editor lines", editorLines, 4260, [1577, 1576]], // 2.7
  // what a tokenizer packs tightest: runs of one character (a run counts once)
  ["a rule of 2,000 dashes", "-".repeat(2000), 2047, [154, 59]], // 13 and 35
  ["2,000 of one letter", "a".repeat(2000), 2047, [279, 278]], // 7.3
  ["headings underlined with dashes", Array.from({ length: 40 }, (_, i) => `Part ${i + 1}\n${"-".repeat(50)}`).join("\n"), 2397, [419, 338]], // 5.7 and 7.1
  ["a table with borders", `| Name | Count | State |\n|${"-".repeat(24)}|${"-".repeat(12)}|${"-".repeat(16)}|\n${Array.from({ length: 40 }, (_, i) => `| item-${i + 1} | ${i * 7} | ok |`).join("\n")}`, 1022, [579, 578]], // 1.8
  ["long German words", Array.from({ length: 30 }, () => "Donaudampfschifffahrtsgesellschaftskapitän Rechtsschutzversicherungsgesellschaften Kraftfahrzeughaftpflichtversicherung").join(" "), 3646, [840, 809]], // 4.3 to 4.5
  ["a list of addresses", Array.from({ length: 30 }, (_, i) => `https://studio.example.com/library/collections/morning-routine/clips/${i + 1}/versions/final-cut-approved`).join("\n"), 3037, [889, 738]], // 3.4 to 4.1
  ["encoded data", Buffer.from(Array.from({ length: 1500 }, (_, i) => (i * 37) % 251)).toString("base64"), 2047, [1426, 1505]], // 1.4
];
const asked = (text: string) => `Answer briefly. ${text}${ask}`;
const of = (name: string) => measured.find((m) => m[0] === name)!;

describe("fewestTokens, against what a model server counted", () => {
  it.each(measured)("%s: the whole request is never taken for a cut one", (_name, text, characters, counted) => {
    expect("Answer briefly.".length + text.length + ask.length).toBe(characters); // the very text that was measured
    expect(fewestTokens(asked(text))).toBeLessThanOrEqual(Math.min(...counted));
  });

  // speech as a transcriber with no punctuation writes it: the least tokens a word of anything measured
  const spoken = Array.from({ length: 30 }, () => "so i went to the store and i got some milk and then i came back home and we sat down and had a cup of tea and it was good and then we went out for a walk in the park and saw a dog and a man with a red hat and he said hello to us and we said hello back and that was the end of the day for us").join(" ");
  it("speech with no punctuation, 1.005 tokens a word, is not taken for a cut request", () => {
    expect(spoken.split(" ")).toHaveLength(2220);
    expect(fewestTokens(spoken)).toBeLessThanOrEqual(2232); // counted 2233 and 2232, with no system text
    expect(fewestTokens(`Answer briefly. ${spoken}`)).toBeLessThanOrEqual(2240); // counted 2241 and 2240
    expect(fewestTokens(Array.from({ length: 800 }, () => "the").join(" "))).toBeLessThanOrEqual(812);
    expect(fewestTokens(Array.from({ length: 600 }, (_, i) => "ai"[i % 2]).join(" "))).toBeLessThanOrEqual(612);
  });

  it("a cut keeps half the server's context, so at most half the count: prose is caught the moment it is cut", () => {
    for (const name of ["english", "russian", "japanese"]) expect(fewestTokens(asked(of(name)[1]))).toBeGreaterThan(Math.max(...of(name)[3]) / 2);
    expect(fewestTokens(spoken)).toBeGreaterThan(2233 / 2);
  });

  it("the gap no count closes: a real job's prompt, cut to under half, still reads as whole plain speech", () => {
    // the script check's own prompt for 500 words: 10,145 characters, 4,536 tokens. A 4,096-token context kept 2,051.
    // Plain speech of 2,051 tokens is about 2,040 words and 8,000 characters: a whole request, and it must pass.
    const kept = 2051;
    expect(fewestTokens(Array.from({ length: 2040 }, () => "the").join(" "))).toBeLessThanOrEqual(kept);
  });

  it("text dense in digits is caught only from over twice the context: half its count still reads as prose", () => {
    const fewest = fewestTokens(asked(of("numbers")[1]));
    const counted = Math.max(...of("numbers")[3]);
    expect(fewest).toBeLessThan(counted / 2); // cut at the limit: not caught
    expect(fewest).toBeGreaterThan(counted / 4.6); // a prompt 2.3 times the context is counted at 1/4.6: caught
  });

  it("runs of spaces and of one character count once, and nothing has no tokens", () => {
    expect(fewestTokens("one      two\n\n\n\t  three")).toBe(2); // three words, nine in ten
    expect(fewestTokens(Array.from({ length: 100 }, () => "one      two\n\n\n\t  three").join("\n"))).toBe(270);
    expect(fewestTokens(`Part 1 ${"=".repeat(700)}`)).toBe(2);
    expect(fewestTokens("   \n ")).toBe(0);
  });
});

describe("asked first whether the whole request fits", () => {
  const route = () => aiFor(admin, "notes", "Video Notes");
  // what one model server answered a 43,725-character request on a 4,096-token context when told not to cut
  const refused = { status: 400, body: { error: "request (10451 tokens) exceeds the available context size (4096 tokens), try increasing it" } };

  it("a server that says no: the job fails with both numbers, the request is never sent, and nothing else answers", async () => {
    saveMyKey("admin", "ANTHROPIC_API_KEY", key);
    await as(admin).put({ url: address, model: "small-one" });
    fits = () => refused;
    const everywhere = vi.spyOn(globalThis, "fetch");
    await expect(completeWithFallback("sys", "a long prompt", undefined, (t) => t, route())).rejects.toMatchObject({
      message: `The local model at ${address} can't read the whole request (it is 10451 tokens and the model's context holds 4096): give it a longer context on its server`,
      code: "FAILED",
      retryable: false,
    });
    await expect(streamWithFallback("sys", "a long prompt", undefined, (t) => t, {}, route())).rejects.toThrow("can't read the whole request");
    expect(everywhere.mock.calls.map((c) => String(c[0]))).toEqual([`${address}/api/chat`, `${address}/api/chat`]);
    expect(sent()).toEqual([]);
  });

  it("a no in other words is passed on as the server said it", async () => {
    await as(admin).put({ url: address, model: "small-one" });
    fits = () => ({ status: 400, body: { error: "the prompt exceeds the context window" } });
    await expect(completeWithFallback("sys", "user", undefined, (t) => t, route())).rejects.toThrow(
      `The local model at ${address} can't read the whole request (the prompt exceeds the context window): give it a longer context on its server`,
    );
    expect(sent()).toEqual([]);
  });

  it("a yes, a server with no such route, or any other answer: the request goes on", async () => {
    await as(admin).put({ url: address, model: "small-one" });
    const others = [
      { status: 200, body: { message: { content: "O" }, done_reason: "length", prompt_eval_count: 3951 } }, // it fits
      noSuchRoute(),
      { status: 400, body: { error: "this model does not take that field" } }, // a no about something else
      { status: 400, body: "not json" },
      { status: 500, body: { error: "exceeds the context" } }, // not a refusal: the server failed
      { status: 404, body: { error: "model 'small-one' not found" } }, // the request itself says so, in its own words
    ];
    for (const other of others) {
      fits = () => other;
      expect(await completeWithFallback("sys", "user", undefined, (t) => t, route())).toBe("from the local model");
    }
    expect(sent()).toHaveLength(others.length);
    expect(got.filter((g) => g.url === "/api/chat")).toHaveLength(others.length);
  });

  it("the question and the request share one line: no other request is in flight between them", async () => {
    await as(admin).put({ url: address, model: "small-one" });
    fits = () => ({ status: 200, body: {} });
    await Promise.all([1, 2, 3].map(() => completeWithFallback("sys", "user", undefined, (t) => t, route())));
    expect(got.map((g) => g.url)).toEqual(["/api/chat", "/v1/messages", "/api/chat", "/v1/messages", "/api/chat", "/v1/messages"]);
  });
});

describe("a prompt longer than the model server's context", () => {
  const long = `The door code for this exercise is PLUM-4821.\n\n${Array.from({ length: 420 }, (_, i) => `Line ${i + 1}: the studio keeps its mats rolled, its windows open and its blocks counted twice each morning.`).join("\n")}\n\nWhat is the door code given at the very start?`;
  // the answer a model gives when the start of the prompt never reached it: a normal one
  const said = (usage?: object) => () => ({ status: 200, body: { content: [{ type: "text", text: "No door code was given." }], stop_reason: "end_turn", ...(usage ? { usage } : {}) } });
  const send = async () => completeWithFallback("Answer briefly.", long, undefined, (t) => t, aiFor(admin, "notes", "Video Notes"));

  it("answered from part of it: the job fails and says what to change, and nothing else answers", async () => {
    saveMyKey("admin", "ANTHROPIC_API_KEY", key);
    await as(admin).put({ url: address, model: "small-one" });
    answer = said({ input_tokens: 2051, cache_read_input_tokens: 0, output_tokens: 12 }); // what a 4,096-token context kept of a prompt this long
    const everywhere = vi.spyOn(globalThis, "fetch");
    await expect(send()).rejects.toMatchObject({
      message: `The local model at ${address} read only part of the request (2051 tokens for a request of ${"Answer briefly.".length + long.length} characters): give it a longer context on its server`,
      code: "FAILED",
      retryable: false,
    });
    expect(everywhere.mock.calls.map((c) => String(c[0]))).toEqual([`${address}/api/chat`, `${address}/v1/messages`]);
  });

  it("read whole, the same prompt answers", async () => {
    await as(admin).put({ url: address, model: "small-one" });
    answer = said({ input_tokens: 10243, cache_read_input_tokens: 0, output_tokens: 12 });
    expect(await send()).toBe("No door code was given.");
  });

  it("a repeat reads almost nothing anew: the tokens the server reused count as read", async () => {
    await as(admin).put({ url: address, model: "small-one" });
    answer = said({ input_tokens: 5, cache_read_input_tokens: 10238, output_tokens: 12 });
    expect(await send()).toBe("No door code was given.");
  });

  it("a server that gives no count can't be checked: its answer goes on", async () => {
    await as(admin).put({ url: address, model: "small-one" });
    answer = said();
    expect(await send()).toBe("No door code was given.");
    answer = said({ input_tokens: 0, output_tokens: 12 });
    expect(await send()).toBe("No door code was given.");
  });
});
