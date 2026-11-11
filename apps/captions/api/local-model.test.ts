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
const { addressOf, localModelOf } = await import("./local-model");
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
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
    got.push(seen);
    const out = req.url === "/v1/models" ? { status: 200, body: { object: "list", data: [{ id: "small-one" }, { id: "big-one:12b" }] } } : answer(seen);
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
const noAi = { only: [], off: "No AI for your account: add one in Settings → Providers, or your Anthropic key in Settings → API keys" };

afterEach(async () => {
  await as(admin).put({ url: null });
  saveMyKey("admin", "ANTHROPIC_API_KEY", null);
  got.length = 0;
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
    expect(everywhere.mock.calls.map((c) => String(c[0]))).toEqual([`${address}/v1/messages`]); // one request, and not to Anthropic
    expect(got).toHaveLength(1);
    expect(got[0].method).toBe("POST");
    expect(got[0].url).toBe("/v1/messages");
    // thinking off: the format's own field, where the Anthropic request has output_config
    expect(got[0].body).toBe('{"model":"big-one:12b","max_tokens":16000,"thinking":{"type":"disabled"},"system":"The system text","messages":[{"role":"user","content":"The user text"}]}');
    expect(got[0].body).not.toContain("output_config");
    expect(got[0].headers).not.toHaveProperty("x-api-key");
    expect(got[0].headers).not.toHaveProperty("authorization");
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
    expect(got[0].body).toBe('{"model":"small-one","max_tokens":16000,"thinking":{"type":"disabled"},"system":"sys","messages":[{"role":"user","content":"user"}]}');
    expect(got[0].headers).not.toHaveProperty("x-api-key");
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
    // two calls, one request each (no retry), both to the local address
    expect(everywhere.mock.calls.map((c) => String(c[0]))).toEqual([`${gone}/v1/messages`, `${gone}/v1/messages`]);
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
    expect(got).toHaveLength(4); // one request per call
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
    expect(got).toHaveLength(2);
  });

  it("an answer that does not parse is not retried anywhere either", async () => {
    saveMyKey("admin", "ANTHROPIC_API_KEY", key);
    await as(admin).put({ url: address, model: "small-one" });
    const everywhere = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(completeWithFallback("sys", "user", undefined, () => { throw new Error("The model returned no JSON"); }, aiFor(admin, "captions", "Caption Studio"))).rejects.toThrow("The model returned no JSON");
    expect(everywhere.mock.calls.map((c) => String(c[0]))).toEqual([`${address}/v1/messages`]);
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
