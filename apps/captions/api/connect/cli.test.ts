import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `creatortoolset connect` against a fake broker that speaks the broker's protocol (device grant, link). The fake
// stands in for fetch, so the command's own requests are the ones it would send.
const scratch = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "cli-connect-"));
process.env.DATA_DIR = path.join(scratch, "data");
process.env.CT_CONNECT_URL = "https://broker.test";
process.env.PORT = "3123";

const { connectCli } = await import("./cli");

const BROKER = "https://broker.test";
const TUNNEL_TOKEN = "tunnel-secret-for-test";
let mode: "approve" | "pending" | "deny" | "expired" | "limit" = "approve";
let polls = 0;
let calls: string[] = [];
let linkedAs: { owner: string; computerId: string } | null = null;
const nonces = new Map<string, true>();
const relayB64 = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");

const mint = (sub: string) => `${Buffer.from(JSON.stringify({ sub, exp: 9_999_999_999 })).toString("base64url")}.sig`;

async function fakeBroker(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = new URL(String(input));
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
  if (u.pathname === "/oauth/device") {
    return json(200, {
      device_code: "device-1",
      user_code: "BCDF-GHJK",
      verification_uri: `${BROKER}/connect`,
      verification_uri_complete: `${BROKER}/connect?code=BCDF-GHJK`,
      interval: 0,
      expires_in: 600,
    });
  }
  if (u.pathname === "/oauth/token") {
    polls++;
    if (mode === "deny") return json(400, { error: "access_denied" });
    if (mode === "expired") return json(400, { error: "expired_token" });
    if (mode === "pending" || (mode === "approve" && polls < 2)) return json(400, { error: "authorization_pending" });
    return json(200, { access_token: mint("acct-1"), token_type: "Bearer", expires_in: 3600 });
  }
  const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return json(401, { error: "unauthorized" });
  if (u.pathname === "/v1/computers") {
    if (mode === "limit") return json(403, { error: "limit_reached" });
    const nonce = randomBytes(16).toString("base64url");
    nonces.set(nonce, true);
    return json(200, { nonce, expires_in: 120 });
  }
  if (u.pathname === "/v1/computers/link") {
    const b = JSON.parse(String(init?.body)) as { public_key: string; payload: string; signature: string };
    const key = createPublicKey({ key: Buffer.from(b.public_key, "base64"), format: "der", type: "spki" });
    if (!verify(null, Buffer.from(b.payload), key, Buffer.from(b.signature, "base64"))) return json(401, { error: "bad_signature" });
    const p = JSON.parse(b.payload) as { nonce: string; origin: string };
    if (!nonces.delete(p.nonce)) return json(401, { error: "bad_challenge" });
    const id = createHash("sha256").update(Buffer.from(b.public_key, "base64")).digest("hex").slice(0, 32);
    linkedAs = { owner: "acct-1", computerId: id };
    return json(200, {
      computer_id: id,
      hostname: `${id}.tunnels.test.example`,
      tunnel_token: TUNNEL_TOKEN,
      relay_kid: "kid-1",
      relay_public_key: relayB64,
    });
  }
  return json(404, { error: "not_found" });
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (l: string) => out.push(l),
    err_: (l: string) => err.push(l),
    sleep: async () => {},
  };
}

const run = (argv: string[], o = io()) =>
  connectCli(argv, { log: o.log, err: o.err_, sleep: o.sleep }).then((code) => ({ code, ...o }));

const stateFile = () => path.join(process.env.DATA_DIR!, "connect.json");

beforeEach(() => {
  mode = "approve";
  polls = 0;
  calls = [];
  linkedAs = null;
  vi.stubGlobal("fetch", vi.fn(fakeBroker));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("creatortoolset connect: refusals leave nothing linked", () => {
  it("refuses an unknown command and a bad flag, without any request", async () => {
    expect((await run(["link"])).code).toBe(2);
    expect((await run(["connect", "--broker"])).code).toBe(2);
    expect((await run(["connect", "extra"])).code).toBe(2);
    expect(calls).toEqual([]);
  });

  it("a declined approval exits 1 and saves no link", async () => {
    mode = "deny";
    const r = await run(["connect"]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/declined/);
    expect(existsSync(stateFile())).toBe(false);
    expect(linkedAs).toBeNull();
  });

  it("an expired code exits 1 and saves no link", async () => {
    mode = "expired";
    const r = await run(["connect"]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/expired/);
    expect(existsSync(stateFile())).toBe(false);
  });

  it("an account at its computer limit exits 1 and saves no link", async () => {
    mode = "limit";
    const r = await run(["connect"]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/computer limit/);
    expect(existsSync(stateFile())).toBe(false);
    expect(linkedAs).toBeNull();
  });
});

describe("creatortoolset connect: the happy path", () => {
  it("prints the code, waits for the approval, links, and saves the tunnel without printing a token", async () => {
    const r = await run(["connect"]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const shown = r.out.join("\n");
    expect(shown).toContain("BCDF-GHJK");
    expect(shown).toContain(`${BROKER}/connect?code=BCDF-GHJK`);
    expect(shown).toContain("Connected as acct-1");
    expect(shown).not.toContain(TUNNEL_TOKEN);
    expect(polls).toBeGreaterThanOrEqual(2);

    expect(linkedAs).not.toBeNull();
    const saved = JSON.parse(readFileSync(stateFile(), "utf8"));
    expect(saved.owner).toBe("acct-1");
    expect(saved.computerId).toBe(linkedAs!.computerId);
    expect(saved.origin).toBe("http://127.0.0.1:3123");
    expect(saved.tunnelToken).toBe(TUNNEL_TOKEN);
    expect(statSync(stateFile()).mode & 0o777).toBe(0o600);
  });

  it("refuses a second connect on a linked computer and changes nothing", async () => {
    const before = readFileSync(stateFile(), "utf8");
    const seen = calls.length;
    const r = await run(["connect"]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/already connected/);
    expect(calls.length).toBe(seen);
    expect(readFileSync(stateFile(), "utf8")).toBe(before);
  });
});
