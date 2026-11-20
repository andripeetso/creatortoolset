import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Ready to post with no final video: the Workshop asks for the file, and POST /sessions/:id/finals puts a library video
// in Finals as the project's final (AddFinalDialog, the chat's finals_link_session version).

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "workshop-final-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "workshop-final-secret";
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { createUser } = await import("./users");
const app = (await import("./boot")).default;
const rootReplaced = (await import("./lib/plugin")).pluginReplaces("/api/workshop");
const { libraryDb } = await import("./library/db");

const cookies: Record<string, string> = {};
async function account(username: string) {
  createUser(username, "password1", { role: "admin" });
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie: cookies[user]!, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const video = (lib: string, id: string, probe: { width: number; height: number } | null) =>
  libraryDb().exec(`
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at, current_version_id) VALUES ('${id}', '${lib}', 'video', '${id}.mp4', 'maker', 0, 'v_${id}');
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
      VALUES ('v_${id}', '${id}', 1, 'k_${id}', 1, 's_${id}', ${probe ? `'${JSON.stringify(probe)}'` : "NULL"}, '${probe ? "ready" : "processing"}', 'maker', 0);
  `);

describe.skipIf(rootReplaced)("Workshop: the final video of a project", () => {
  it("asks while there is none, waits for the library to read a new file, and links it", async () => {
    await account("maker");
    await account("other");
    const s = (await (await call("maker", "POST", "/api/workshop/sessions", { title: "Tiny Acrobatics rolls" })).json()) as { id: string };
    const url = `/api/workshop/sessions/${s.id}/finals`;

    const before = (await (await call("maker", "GET", url)).json()) as { linked: boolean; libraryId: string };
    expect(before.linked).toBe(false);
    expect(before.libraryId).toBeTruthy();

    video(before.libraryId, "ast_new", null);
    expect((await call("maker", "POST", url, { assetId: "ast_new" })).status).toBe(202);

    video(before.libraryId, "ast_small", { width: 540, height: 960 });
    expect((await call("maker", "POST", url, { assetId: "ast_small" })).status).toBe(409);

    // another account's video is not found, whatever its size
    const theirs = (await (await call("other", "GET", `/api/workshop/sessions/${((await (await call("other", "POST", "/api/workshop/sessions", { title: "x" })).json()) as { id: string }).id}/finals`)).json()) as { libraryId: string };
    video(theirs.libraryId, "ast_theirs", { width: 1080, height: 1920 });
    expect((await call("maker", "POST", url, { assetId: "ast_theirs" })).status).toBe(404);

    // one hidden while it waits on Folders left out (library/report.ts) is no final: not found
    video(before.libraryId, "ast_hid", { width: 1080, height: 1920 });
    libraryDb().prepare("UPDATE assets SET left_hidden_at = 1 WHERE id = 'ast_hid'").run();
    const hid = await call("maker", "POST", url, { assetId: "ast_hid" });
    expect(hid.status).toBe(404);
    expect(await hid.json()).toEqual({ error: "No such video of yours" });

    video(before.libraryId, "ast_final", { width: 1080, height: 1920 });
    const linked = await call("maker", "POST", url, { versionId: "v_ast_final" });
    expect(linked.status).toBe(200);
    expect(((await linked.json()) as { pieceId: string }).pieceId).toBeTruthy();
    expect(((await (await call("maker", "GET", url)).json()) as { linked: boolean }).linked).toBe(true);
  });
});
