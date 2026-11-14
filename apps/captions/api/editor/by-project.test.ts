import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EditSummary } from "../../contracts/editor";

// A project keeps its own work apart: an edit is in the project it was made in, and the list asked for a project has
// only that project's (the new-chat screen's "Carry on with" asks for the one the person is in). An edit from before
// edits had a project is the first brand's, as the Workshop filed its own old records.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-by-project-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-by-project-secret";

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
// a loaded plug-in that replaces /api/editor answers the list itself (it has the same rule: its own test)
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");

const cookies: Record<string, string> = {};
async function login(username: string) {
  setOff(createUser(username, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie: cookies[user]!, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const edit = async (user: string, name: string, more: Record<string, unknown> = {}) => (await json<{ id: string }>(call(user, "POST", "/api/editor", { name, sources: [`ver_${user}`], ...more }))).id;
const names = async (user: string, query = "") => (await json<EditSummary[]>(call(user, "GET", `/api/editor${query}`))).map((e) => e.name).sort();
const project = async (user: string, name: string) => (await json<{ id: string }>(call(user, "POST", "/api/workshop/projects", { name }))).id;

beforeAll(async () => {
  for (const u of ["maker", "other", "third"]) {
    await login(u);
    libraryDb().exec(`
      INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_${u}', '${u}', 'A', 'local', 0);
      INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES ('ast_${u}', 'lib_${u}', 'video', 'Take 1', '${u}', 0, NULL);
      INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_${u}', 'ast_${u}', 1, 'k1', 1, 'x1', 'ready', '${u}', 0);
    `);
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(rootReplaced)("AI Editor: edits kept apart by project", () => {
  it("an edit is in the project it was made in; one from before projects is the first brand's; a list asked for a project has only its own", async () => {
    // before there were projects: no project of its own
    await edit("maker", "Old take");
    const first = await project("maker", "Tiny Acrobatics");
    const second = await project("maker", "Second brand");
    // made in the project he is in, unless another of his is asked for
    expect((await call("maker", "PATCH", "/api/workshop/workspace", { currentProjectId: second })).status).toBe(200);
    await edit("maker", "Second's reel");
    await edit("maker", "First's reel", { projectId: first });
    // a project id that is not his is not taken: the one he is in
    const theirs = await project("other", "Their brand");
    await edit("maker", "Asked for theirs", { projectId: theirs });

    expect(await names("maker", `?projectId=${first}`)).toEqual(["First's reel", "Old take"]);
    expect(await names("maker", `?projectId=${second}`)).toEqual(["Asked for theirs", "Second's reel"]);
    // no project asked for, or one that is not his: every edit of his, as before
    const all = ["Asked for theirs", "First's reel", "Old take", "Second's reel"];
    expect(await names("maker")).toEqual(all);
    expect(await names("maker", `?projectId=${theirs}`)).toEqual(all);
    // nobody else's edits, whatever is asked
    expect(await names("other", `?projectId=${theirs}`)).toEqual([]);
    expect(await names("other", `?projectId=${first}`)).toEqual([]);
    // the whole list says each edit's project (the Edits page keeps them apart by it): the old one is the first brand's
    // and no other's
    const where = Object.fromEntries((await json<EditSummary[]>(call("maker", "GET", "/api/editor"))).map((e) => [e.name, e.projectId]));
    expect(where).toEqual({ "Old take": first, "First's reel": first, "Second's reel": second, "Asked for theirs": second });
  });

  it("a person with no project: every edit, and none says a project", async () => {
    await login("solo");
    libraryDb().exec(`
      INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_solo', 'solo', 'A', 'local', 0);
      INSERT INTO assets (id, library_id, kind, title, created_by, created_at, trashed_at) VALUES ('ast_solo', 'lib_solo', 'video', 'Take 1', 'solo', 0, NULL);
      INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_solo', 'ast_solo', 1, 'k1', 1, 'x1', 'ready', 'solo', 0);
    `);
    await edit("solo", "Solo take");
    const list = await json<EditSummary[]>(call("solo", "GET", "/api/editor"));
    expect(list.map((e) => [e.name, e.projectId])).toEqual([["Solo take", undefined]]);
  });

  it("an edit whose project is deleted goes with the first brand's", async () => {
    const first = await project("third", "Third's first");
    const later = await project("third", "Third's later");
    await edit("third", "Made in the later one", { projectId: later });
    expect(await names("third", `?projectId=${first}`)).toEqual([]);
    expect(await names("third", `?projectId=${later}`)).toEqual(["Made in the later one"]);
    expect((await call("third", "DELETE", `/api/workshop/projects/${later}`)).status).toBeLessThan(300);
    expect(await names("third", `?projectId=${first}`)).toEqual(["Made in the later one"]);
  });
});
