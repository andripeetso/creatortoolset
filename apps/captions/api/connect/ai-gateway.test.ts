import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// An AI app through the Connect broker to this computer, with both halves real: the broker's own code
// (apps/relay/src, called as a function) and this app (boot). The test plays the AI app (register, authorize, token,
// MCP requests), the hosted site (info, approve as the account) and the person's browser on the computer's Allow page.
// Nothing here is a stand-in for either side's protocol, so a mismatch between them fails here.
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "ai-gateway-"));
process.env.APP_SECRET = "ai-gateway-test-secret";
const BROKER = "https://connect.test.example";
process.env.CT_CONNECT_URL = BROKER;

const app = (await import("../boot")).default;
const users = await import("../users");
const { computerKey, keyId } = await import("./keys");
const { saveConnectState } = await import("./state");
const relay = await import("../../../relay/src/server.ts");
const { openDb } = await import("../../../relay/src/db.ts");
const { loadSigningKey, publicKeyB64 } = await import("../../../relay/src/keys.ts");
const { freeLimit } = await import("../../../relay/src/limits.ts");
const { mintAccountToken } = await import("../../../relay/src/tickets.ts");

const ACCOUNT = "acct-1";
const SECRET = randomBytes(32);
const now = () => Math.floor(Date.now() / 1000);
const s256 = (s: string) => createHash("sha256").update(s).digest("base64url");
const socket = { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50000, remoteFamily: "IPv4" } } };

// this computer, linked to the account: its id is its key's id, and the broker has its row
const id = keyId(computerKey().publicKey);
const HOST = `${id}.tunnels.test.example`;
const signing = loadSigningKey(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), "/unused");
const deps: import("../../../relay/src/server.ts").Deps = {
  db: openDb(":memory:"),
  cf: {} as never, // the broker asks Cloudflare only to link and unlink, which this test does not do
  now,
  limitFor: freeLimit(3),
  tunnelDomain: "tunnels.test.example",
  publicUrl: BROKER,
  accountSecret: SECRET,
  signing,
  gateway: {
    secret: randomBytes(32),
    // where a real broker goes through the tunnel, this one calls the app, as the tunnel would: on its hostname, from this machine
    fetch: ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(app.request(String(input), init, socket))) as typeof fetch,
  },
};
deps.db
  .prepare("INSERT INTO computers (id, account_id, name, origin, hostname, tunnel_id, dns_id, created_at) VALUES (?, ?, 'Studio Mac', 'http://127.0.0.1:4000', ?, 'tun-1', 'dns-1', ?)")
  .run(id, ACCOUNT, HOST, now());
saveConnectState({ brokerUrl: BROKER, owner: ACCOUNT, localUser: "owner", computerId: id, name: "Studio Mac", origin: "http://127.0.0.1:4000", hostname: HOST, tunnelToken: "t", relayKid: signing.kid, relayPublicKey: publicKeyB64(signing.publicKey), usedJti: {} });

// whatever this app sends to the broker's address reaches the broker's own code
vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(BROKER)) throw new Error(`unexpected request to ${url}`);
  return relay.handle(deps, new Request(url, init));
});
afterAll(() => vi.unstubAllGlobals());

users.createUser("owner", "tinyacrobatics1", { role: "admin" });
/** The person's browser on the computer's own address (through its tunnel), signed in with the computer's password. */
const onComputer = (p: string, init: RequestInit = {}) => app.request(`https://${HOST}${p}`, init, socket);
const cookie = ((await onComputer("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "owner", password: "tinyacrobatics1" }) })).headers.get("set-cookie") ?? "").split(";")[0]!;
const asOwner = (p: string, method: string, body?: unknown) =>
  onComputer(p, { method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });

const broker = (p: string, init: RequestInit = {}) => relay.handle(deps, new Request(`${BROKER}${p}`, init));
const asAccount = async (p: string, body: unknown) =>
  (await broker(p, { method: "POST", headers: { authorization: `Bearer ${mintAccountToken(SECRET, ACCOUNT, now())}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<Record<string, any>>;

/** The AI app's side: registers with the broker, starts a sign-in, and can swap the code it gets for its token. */
async function aiApp(redirect: string) {
  const reg = (await (await broker("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "some-mcp-client", redirect_uris: [redirect] }) })).json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: s256(verifier), code_challenge_method: "S256", state: "st8" });
  const to = new URL((await broker(`/oauth/authorize?${q}`)).headers.get("location")!);
  const token = async (back: string) => {
    const r = await broker("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: new URL(back).searchParams.get("code") ?? "", client_id: reg.client_id, code_verifier: verifier, redirect_uri: redirect }).toString(),
    });
    return ((await r.json()) as { access_token: string }).access_token;
  };
  return { req: to.searchParams.get("req")!, token };
}
let n = 0;
const mcp = (token: string, method: string, params: unknown = {}) =>
  broker("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) });
const keysOf = () => (users.findUser("owner")!.aiKeys ?? []).filter((k) => k.oauth).map((k) => k.name);

describe("an AI app through the Connect broker to this computer", () => {
  it("Install on the computer, then the app signs in to the account: its requests reach this app and come back", async () => {
    const info = async (req: string) => (await asAccount("/oauth/authorize/info", { req })) as { app: string; computers: { id: string; ready: boolean }[] };
    const chatgpt = await aiApp("https://chatgpt.com/connector/callback");
    expect(await info(chatgpt.req)).toMatchObject({ app: "ChatGPT", computers: [{ id, ready: false }] });

    // the Install button in Settings → Headless access
    expect((await asOwner("/api/connect/ai", "POST", { app: "ChatGPT", on: true })).status).toBe(200);
    expect(keysOf()).toEqual(["ChatGPT"]);
    expect((await info(chatgpt.req)).computers[0]!.ready).toBe(true);

    const { redirect } = await asAccount("/oauth/authorize/approve", { req: chatgpt.req, computer_id: id, approve: true });
    expect(redirect).toMatch(/^https:\/\/chatgpt\.com\/connector\/callback\?code=/);
    const token = await chatgpt.token(redirect);

    const init = (await (await mcp(token, "initialize", { protocolVersion: "2025-06-18" })).json()) as { result: { serverInfo: { name: string }; instructions: string } };
    expect(init.result.serverInfo.name).toBe("creator-toolset");
    expect(init.result.instructions).toContain("Content Workshop");
    const tools = ((await (await mcp(token, "tools/list")).json()) as { result: { tools: { name: string; _meta?: unknown }[] } }).result.tools;
    expect(tools.find((t) => t.name === "media_search")?._meta).toBeDefined();

    // a tool that writes: the session is made in this app, as the owner, and its card opens it through the broker's address
    const made = (await (await mcp(token, "tools/call", { name: "workshop_new_session", arguments: { title: "Tiny tumbles" } })).json()) as { result: { content: { text: string }[]; _meta: { card: { kind: string; href: string } } } };
    const session = JSON.parse(made.result.content[0]!.text) as { id: string };
    expect(made.result._meta.card).toMatchObject({ kind: "script", href: `${BROKER}/open/${id}/workshop/sessions/${session.id}` });
    expect(((await (await asOwner("/api/workshop/sessions", "GET")).json()) as { id: string }[]).some((s) => s.id === session.id)).toBe(true);

    // the card's page may load pictures from the broker only
    const page = (await (await mcp(token, "resources/read", { uri: "ui://creator-toolset/card" })).json()) as { result: { contents: { _meta: { ui: { csp: { resourceDomains: string[] } } } }[] } };
    expect(page.result.contents[0]!._meta.ui.csp.resourceDomains).toEqual([BROKER]);

    // Remove in the app ends it at the broker too
    expect((await asOwner("/api/connect/ai", "POST", { app: "ChatGPT", on: false })).status).toBe(200);
    expect(keysOf()).toEqual([]);
    expect((await mcp(token, "tools/list")).status).toBe(401);
  });

  it("without Install: the browser goes on to this computer's own Allow page, and Allow there finishes it", async () => {
    const claude = await aiApp("https://claude.ai/api/mcp/auth_callback");
    const { redirect } = await asAccount("/oauth/authorize/approve", { req: claude.req, computer_id: id, approve: true });
    const allow = new URL(redirect);
    expect(allow.origin + allow.pathname).toBe(`https://${HOST}/oauth/authorize`);

    // the computer's page names the app; the person presses Allow
    const html = await (await onComputer(allow.pathname + allow.search, { headers: { cookie } })).text();
    expect(html).toContain("Connect Claude?");
    const ask = /name="ask" value="([^"]+)"/.exec(html)![1]!;
    const pressed = await onComputer("/oauth/authorize", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ask, do: "allow" }).toString() });
    const back = new URL(pressed.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(`${BROKER}/oauth/computer/callback`);

    // the broker swaps the computer's code for its key and sends the browser back to the AI app
    const done = await broker(back.pathname + back.search);
    expect(done.status).toBe(302);
    const token = await claude.token(done.headers.get("location")!);
    expect((await mcp(token, "tools/list")).status).toBe(200);
    expect(keysOf()).toEqual(["Claude"]);

    // removed in Settings → Headless access the usual way: the next request ends the connection at the broker
    const key = users.findUser("owner")!.aiKeys!.find((k) => k.name === "Claude")!;
    expect((await asOwner(`/api/auth/api-key?id=${key.id}`, "DELETE")).status).toBe(200);
    const after = await mcp(token, "tools/list");
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");
    expect(Number((deps.db.prepare("SELECT COUNT(*) AS n FROM ai_grants").get() as { n: number }).n)).toBe(0);
  });
});
