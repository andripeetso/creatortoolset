import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "oauth-"));
process.env.APP_SECRET = "oauth-test-secret";

const { createUser, findUser, newAiKey, newApiKey } = await import("./users");
const { mintJobToken } = await import("./auth");
const app = (await import("./boot")).default;
const { LABELLED } = await import("./mcp");
const { backPath } = await import("./sign-in");

createUser("oauthowner", "password1");
const login = await app.request("/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "oauthowner", password: "password1" }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;

const REDIRECT = "https://chat.example.com/oauth/callback";
const register = async (body: Record<string, unknown> = { client_name: "Chat Example", redirect_uris: [REDIRECT] }) =>
  app.request("/api/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Register, sign in, press Allow: the code and the verifier that goes with it. */
async function allow(clientId: string, verifier = randomBytes(32).toString("base64url")) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "st8",
  });
  const page = await app.request(`/oauth/authorize?${q}`, { headers: { cookie } });
  expect(page.status).toBe(200);
  const html = await page.text();
  const ask = /name="ask" value="([^"]+)"/.exec(html)![1]!;
  const r = await app.request("/oauth/authorize", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ask, do: "allow" }) });
  expect(r.status).toBe(302);
  const to = new URL(r.headers.get("location")!);
  return { to, code: to.searchParams.get("code")!, verifier, html };
}
const token = (body: Record<string, string>, headers: Record<string, string> = {}) =>
  app.request("/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ grant_type: "authorization_code", redirect_uri: REDIRECT, ...body }) });
const mcp = (authorization: string) =>
  app.request("/api/mcp", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });

describe("OAuth for the MCP server", () => {
  it("points an AI app from a 401 to the metadata, and the metadata to the endpoints", async () => {
    const r = await mcp("");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe('Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource/api/mcp"');
    const res = (await (await app.request("/.well-known/oauth-protected-resource/api/mcp")).json()) as { resource: string; authorization_servers: string[] };
    expect(res).toMatchObject({ resource: "http://localhost/api/mcp", authorization_servers: ["http://localhost"] });
    const meta = (await (await app.request("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({ authorization_endpoint: "http://localhost/oauth/authorize", token_endpoint: "http://localhost/api/oauth/token", code_challenge_methods_supported: ["S256"] });
  });

  it("signs in, asks, and hands back a named Full key that opens /api/mcp", async () => {
    const reg = (await (await register()).json()) as { client_id: string; token_endpoint_auth_method: string };
    expect(reg.token_endpoint_auth_method).toBe("none");
    const { to, code, verifier, html } = await allow(reg.client_id);
    expect(html).toContain("Connect Chat Example?");
    expect(to.origin + to.pathname).toBe(REDIRECT);
    expect(to.searchParams.get("state")).toBe("st8");

    // the wrong verifier spends the code
    expect((await token({ code, client_id: reg.client_id, code_verifier: "x".repeat(43) })).status).toBe(400);
    expect((await token({ code, client_id: reg.client_id, code_verifier: verifier })).status).toBe(400);

    const again = await allow(reg.client_id);
    const t = (await (await token({ code: again.code, client_id: reg.client_id, code_verifier: again.verifier })).json()) as { access_token: string; token_type: string };
    expect(t.token_type).toBe("Bearer");
    expect((await mcp(`Bearer ${t.access_token}`)).status).toBe(200);
    expect(findUser("oauthowner")!.aiKeys?.map((k) => k.name)).toContain("Chat Example");
    // it speaks MCP and nothing else: the account's other routes stay shut to it, where a pasted Full key opens them
    const sessions = (authorization: string) => app.request("/api/workshop/sessions", { headers: { authorization } });
    expect((await sessions(`Bearer ${t.access_token}`)).status).toBe(401);
    expect((await app.request("/api/review/assets", { headers: { authorization: `Bearer ${t.access_token}` } })).status).toBe(401);
    expect((await sessions(`Bearer ${newApiKey(findUser("oauthowner")!, "full")}`)).status).toBe(200);
    // and its tools still do their work, as the account
    const made = await app.request("/api/mcp", { method: "POST", headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "workshop_new_session", arguments: { title: "Through MCP" } } }) });
    expect(((await made.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    // once only
    expect((await token({ code: again.code, client_id: reg.client_id, code_verifier: again.verifier })).status).toBe(400);
  });

  it("sends a signed-out browser to sign in first, and back here after", async () => {
    const reg = (await (await register()).json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: "a".repeat(43), code_challenge_method: "S256" });
    const r = await app.request(`/oauth/authorize?${q}`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/login?next=${encodeURIComponent(`/oauth/authorize?${q}`)}`);
  });

  it("a provider sign-in keeps the whole request to come back to (Claude's, two return links, a long state)", async () => {
    const reg = (await (await register({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"] })).json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: "a".repeat(43), code_challenge_method: "S256", state: "s".repeat(43), resource: "https://creatortoolset.com/api/mcp", scope: "" });
    // what the login page's buttons send as next= (AuthGate backHere): the login page with its own next=
    const back = `/login?${new URLSearchParams({ next: `/oauth/authorize?${q}` })}`;
    expect(back.length).toBeGreaterThan(500);
    expect(backPath(back)).toBe(back);
  });

  it("refuses a return link it wasn't registered with, a forged client and a forged Allow", async () => {
    const reg = (await (await register()).json()) as { client_id: string };
    const bad = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://evil.example/cb", code_challenge: "a".repeat(43), code_challenge_method: "S256" });
    expect((await app.request(`/oauth/authorize?${bad}`, { headers: { cookie } })).status).toBe(400);
    const forged = new URLSearchParams({ ...Object.fromEntries(bad), client_id: reg.client_id.replace(/\.[^.]+$/, ".AAAA"), redirect_uri: REDIRECT });
    expect((await app.request(`/oauth/authorize?${forged}`, { headers: { cookie } })).status).toBe(400);
    const post = await app.request("/oauth/authorize", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ask: "e30.AAAA", do: "allow" }) });
    expect(post.status).toBe(400);
    expect((await register({ redirect_uris: ["http://evil.example/cb"] })).status).toBe(400);
  });

  it("Cancel goes back with access_denied", async () => {
    const reg = (await (await register()).json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: "a".repeat(43), code_challenge_method: "S256", state: "s" });
    const html = await (await app.request(`/oauth/authorize?${q}`, { headers: { cookie } })).text();
    const ask = /name="ask" value="([^"]+)"/.exec(html)![1]!;
    const r = await app.request("/oauth/authorize", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ask, do: "deny" }) });
    expect(r.headers.get("location")).toBe(`${REDIRECT}?error=access_denied&state=s`);
  });

  it("a client registered with a secret must send it", async () => {
    const reg = (await (await register({ client_name: "Secretive", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" })).json()) as { client_id: string; client_secret: string };
    const a = await allow(reg.client_id);
    expect((await token({ code: a.code, client_id: reg.client_id, code_verifier: a.verifier })).status).toBe(401);
    const b = await allow(reg.client_id);
    const basic = Buffer.from(`${encodeURIComponent(reg.client_id)}:${encodeURIComponent(reg.client_secret)}`).toString("base64");
    expect((await token({ code: b.code, code_verifier: b.verifier }, { authorization: `Basic ${basic}` })).status).toBe(200);
  });
});

it("names a known app's key after its Settings row, and connecting again replaces the key", async () => {
  const reg = (await (await register({ client_name: "openai-mcp", redirect_uris: [REDIRECT.replace("chat.example.com", "chatgpt.com")] })).json()) as { client_id: string; client_name: string };
  expect(reg.client_name).toBe("ChatGPT");
  const once = async () => {
    const verifier = randomBytes(32).toString("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://chatgpt.com/oauth/callback", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
    const ask = /name="ask" value="([^"]+)"/.exec(await (await app.request(`/oauth/authorize?${q}`, { headers: { cookie } })).text())![1]!;
    const r = await app.request("/oauth/authorize", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ask, do: "allow" }) });
    const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
    const t = await app.request("/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, code_verifier: verifier }) });
    return ((await t.json()) as { access_token: string }).access_token;
  };
  // a key Install made, under the name an app could claim for itself, is left alone
  const installed = newAiKey(findUser("oauthowner")!, "ChatGPT").key;
  const first = await once();
  const second = await once();
  expect(findUser("oauthowner")!.aiKeys!.filter((k) => k.name === "ChatGPT" && k.oauth)).toHaveLength(1);
  expect((await mcp(`Bearer ${first}`)).status).toBe(401);
  expect((await mcp(`Bearer ${second}`)).status).toBe(200);
  expect((await mcp(`Bearer ${installed}`)).status).toBe(200);
});

describe("MCP tool labels", () => {
  it("every built-in tool is labelled read, add or replace, with a title", async () => {
    type Listed = { result: { tools: Array<{ name: string; title?: string; annotations?: Record<string, unknown> }> } };
    // the dock lists every tool, and lists them without labels
    const dock = (await (await mcp(`Bearer ${mintJobToken("oauthowner", "turn-1")}`)).json()) as Listed;
    const names = dock.result.tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(30);
    expect(names.filter((n) => !LABELLED.has(n))).toEqual([]);
    expect(dock.result.tools.some((t) => t.annotations || t.title)).toBe(false);
    const key = `Bearer ${newApiKey(findUser("oauthowner")!, "full")}`;
    const list = (await (await mcp(key)).json()) as Listed;
    expect(list.result.tools.every((t) => t.title && t.annotations)).toBe(true);
    const search = list.result.tools.find((t) => t.name === "media_search")!;
    expect(search).toMatchObject({ title: "Media search", annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(list.result.tools.find((t) => t.name === "editor_delete")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
