import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-sound-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-sound-test-secret";
delete process.env.CT_LOCAL;
// the server's video work off: a source's measuring waits for one of the asker's computers
vi.mock("../work/server-work", async (real) => ({ ...(await real<typeof import("../work/server-work")>()), serverWorks: () => false }));

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { WAITS_FOR_COMPUTER } = await import("../library/jobs");
const { LOUD_WAIT_MS, NO_COMPUTER, soundOf } = await import("./sound");

const cookies: Record<string, string> = {};
async function login(username: string) {
  setOff(createUser(username, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const ask = (user: string, body: unknown) =>
  app.request("/api/editor/sound", { method: "POST", headers: { cookie: cookies[user]!, "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  for (const u of ["maker", "other"]) await login(u);
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_a', 'maker', 'A', 'local', '{}', 0), ('lib_b', 'other', 'B', 'local', '{}', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_a', 'lib_a', 'video', 'Tiny Acrobatics take', 'maker', 0), ('ast_b', 'lib_b', 'video', 'Theirs', 'other', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES
      ('ver_a', 'ast_a', 1, 'k1', 1, 'x1', 'ready', 'maker', 0), ('ver_b', 'ast_b', 1, 'k2', 1, 'x2', 'ready', 'other', 0);
  `);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(rootReplaced)("POST /api/editor/sound (Normalize's measuring)", () => {
  it("another account's clip, or one that is not there, is Not found; no list is refused", async () => {
    expect(await (await ask("maker", { sources: ["ver_b", "ver_nope"] })).json()).toEqual({ ver_b: { error: "Not found" }, ver_nope: { error: "Not found" } });
    expect((await ask("maker", { sources: [] })).status).toBe(400);
  });

  it("waits for a computer with the file, then gives up plainly; asking again starts over", async () => {
    expect(await (await ask("maker", { sources: ["ver_a"] })).json()).toEqual({ ver_a: { line: WAITS_FOR_COMPUTER } });
    // still waiting a moment later: the same task, not placed again
    expect(await soundOf("maker", ["ver_a"], Date.now() + 1000)).toEqual({ ver_a: { line: WAITS_FOR_COMPUTER } });
    expect(await soundOf("maker", ["ver_a"], Date.now() + LOUD_WAIT_MS + 1000)).toEqual({ ver_a: { error: NO_COMPUTER } });
    expect(await soundOf("maker", ["ver_a"])).toEqual({ ver_a: { line: WAITS_FOR_COMPUTER } });
  });
});
