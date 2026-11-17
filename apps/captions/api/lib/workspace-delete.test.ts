import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceContents } from "../../contracts/workspaces";

// Deleting a workspace deletes everything in it (owner, 2026-11-16), and nothing of another workspace's: the confirm's
// counts are what goes, and the person's own folder on disk stays as it is.
const root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "ws-delete-"));
const dir = path.join(root, "data");
const own = path.join(root, "My footage"); // the person's own folder: never the app's to delete
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "ws-delete-secret";

const at = (...p: string[]) => path.join(dir, ...p);
const put = (file: string, data: unknown) => (mkdirSync(path.dirname(file), { recursive: true }), writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data)));
const A = "bbbbbbbb-0000-4000-8000-000000000001"; // the first brand: the oldest
const B = "bbbbbbbb-0000-4000-8000-000000000002";
for (const [id, name, createdAt] of [[A, "Tiny Acrobatics", 1], [B, "Northlight", 2]] as const)
  put(at("workshop", "projects", `${id}.json`), { id, owner: "alex", name, audience: "", voice: "", cta: "", notes: "", createdAt, updatedAt: createdAt });
// a team where alex gave bo workspace B (Settings → Team), written before anything reads it
put(at("workspaces.json"), {
  workspaces: [{ id: "team-1", name: "Team", plan: "team", comped: false, createdAt: 0, members: [{ username: "alex", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 }, { username: "bo", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0, workspaces: [B] }] }],
  invites: [],
  spend: {},
});

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const { libraryDb } = await import("../library/db");
const { pluginWorkspaceStores } = await import("./plugin");

const cookies: Record<string, string> = {};
async function login(username: string) {
  setOff(createUser(username, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie: cookies[user]!, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const contents = async (id: string) => (await (await call("alex", "GET", `/api/workshop/projects/${id}/contents`)).json()) as WorkspaceContents;
const counts = (c: WorkspaceContents) => Object.fromEntries(c.items.map((i) => [i.what, i.n]));

/**
 * One record of every kind in workspace `ws` (undefined: unstamped), each the app's own file: `files` are the paths that
 * hold them, `everywhere` the ones that with no stamp are in every workspace (a session, an Analyzer account and its post).
 */
function seed(ws: string | undefined, tag: string): { files: string[]; everywhere: string[] } {
  const p = ws ? { projectId: ws } : {};
  const id = () => randomUUID();
  const files: string[] = [];
  const everywhere: string[] = [];
  const meta = (dirName: string, m: Record<string, unknown>, list = files) => {
    const mid = id();
    const f = at(dirName, mid, "meta.json");
    put(f, { id: mid, owner: "alex", createdAt: 1, updatedAt: 1, ...m });
    list.push(path.dirname(f));
  };
  meta(path.join("workshop", "sessions"), { title: `${tag} script`, query: "", status: "draft", sources: [], drafts: [], ...p }, everywhere);
  meta("projects", { name: `${tag} captions`, duration: 0, clips: [], ...p });
  meta("clips", { name: `${tag} note`, ...p });
  meta("documents", { name: `${tag} guide`, ...p });
  meta("enhance", { name: `${tag} audio`, ...p });
  const review = id();
  put(at("review", review, "meta.json"), { id: review, owner: "alex", name: `${tag} cut`, versions: [], approval: { status: "none" }, createdAt: 1, updatedAt: 1, ...(ws ? { workspace: ws } : {}) });
  files.push(at("review", review));
  const edit = id();
  put(at("editor", edit, "edit.json"), { id: edit, name: `${tag} edit`, createdBy: "alex", sources: [], createdAt: 1, updatedAt: 1, ...p });
  files.push(at("editor", edit));
  const story = at("stories", `${id()}.json`);
  put(story, { id: path.basename(story, ".json"), owner: "alex", name: tag, cuts: [], duration: 0, createdAt: 1, updatedAt: 1, ...p });
  const design = at("designs", "alex", `${id()}.json`);
  put(design, { id: path.basename(design, ".json"), owner: "alex", title: tag, pages: [], createdAt: 1, updatedAt: 1, ...(ws ? { project: ws } : {}) });
  files.push(story, design);
  const account = id();
  put(at("instagram", "accounts", account, "meta.json"), { id: account, owner: "alex", username: `${tag}brand`.toLowerCase(), createdAt: 1, ...p });
  const post = id();
  put(at("instagram", post, "meta.json"), { id: post, owner: "alex", accountId: account, creator: { username: `${tag}brand`.toLowerCase() }, slides: [], createdAt: 1 });
  everywhere.push(at("instagram", "accounts", account), at("instagram", post));
  if (ws) {
    // kept to one workspace only when stamped: with no stamp these are in every workspace
    const source = id();
    put(at("workshop", "sources", `${source}.json`), { id: source, owner: "alex", name: `${tag}.md`, chars: 3, status: "read", createdAt: 1, updatedAt: 1, projectId: ws });
    put(at("workshop", "sources", `${source}.txt`), "abc");
    files.push(at("workshop", "sources", `${source}.json`), at("workshop", "sources", `${source}.txt`));
    put(at("instagram", "users", "alex", `idea-board-${ws}.json`), { ideas: [] });
    files.push(at("instagram", "users", "alex", `idea-board-${ws}.json`));
  }
  return { files, everywhere };
}

let a: ReturnType<typeof seed>;
let b: ReturnType<typeof seed>;
const lib = { b: "lib_b", a: "lib_a" };
const take = path.join(own, "take.mov");

beforeAll(async () => {
  await login("alex");
  await login("bo");
  a = seed(A, "A");
  b = seed(B, "B");
  // per-account files: one entry for each workspace, and one for every workspace
  put(at("assistant", "alex.json"), {
    id: "chat-b",
    workspace: B,
    messages: [{ id: "m1", role: "user", text: "for B", at: 1 }],
    past: [{ id: "chat-a", workspace: A, messages: [{ id: "m2", role: "user", text: "for A", at: 1 }] }],
  });
  put(at("memory", "alex.json"), { facts: [{ id: "fa", text: "A's", at: 1, project: A, from: "m" }, { id: "fb", text: "B's", at: 1, project: B, from: "m" }, { id: "fall", text: "Everyone's", at: 1, from: "m" }], removed: [] });
  put(at("memory", "bo.json"), { facts: [{ id: "bob", text: "Bo's for B", at: 1, project: B, from: "m" }], removed: [] });
  const task = (tid: string, project?: string) => ({ id: tid, name: tid, prompt: "x", schedule: { kind: "fixed", at: "09:00" }, timezone: "UTC", enabled: false, createdAt: 1, destination: "new_chat", ...(project ? { project } : {}) });
  put(at("automations", "alex.json"), [task("ta", A), task("tb", B), task("tall")]);
  put(at("connectors", "alex.json"), { accounts: [{ key: "youtube:a", platform: "youtube", platformId: "a", handle: "a", via: "apify", projectId: A, connectedAt: 1 }, { key: "youtube:b", platform: "youtube", platformId: "b", handle: "b", via: "apify", projectId: B, connectedAt: 1 }] });
  put(at("folders", "notes", "alex.json"), { folders: [{ id: "fa", name: "A", parentId: null, createdAt: 1, workspace: A }, { id: "fb", name: "B", parentId: null, createdAt: 1, workspace: B }], items: {} });
  put(at("workshop", "users", "alex.edits.json"), [{ key: "a", projectId: A }, { key: "b", projectId: B }, { key: "all" }]);
  const note = (id: string, workspace: string) => ({ id, kind: "workshop", by: "Content Workshop", assetId: randomUUID(), name: id, href: "/", at: 1, workspace });
  put(at("review", "notifications", "alex.json"), [note("na", A), note("nb", B)]);
  // the person's own footage folder, read in place by B's Media Library through a link
  put(take, "the person's own video");
  const folder = (fid: string, ws: string) => ({ id: fid, role: "footage", name: "My footage", origin: { host: "mac", path: own }, make: false, createdAt: 1, reach: {}, workspace: ws });
  put(at("storage", "alex.json"), { folders: [folder("sa", A), folder("sb", B)] });
  for (const [ws, l] of [[A, lib.a], [B, lib.b]] as const) {
    libraryDb().exec(`
      INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('${l}', 'team-1', 'Library', 'local', '{"projectId":"${ws}"}', 0);
      INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_${l}', '${l}', 'video', 'Take', 'alex', 0);
      INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_${l}', 'ast_${l}', 1, 'libraries/${l}/v/ver_${l}/source', 1, 'x', 'ready', 'alex', 0);
    `);
    const link = at("library", "blobs", "libraries", l, "v", `ver_${l}`, "source");
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(take, link);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ONE_EACH = {
  project: 1, chat: 1, "Review video": 1, "AI Editor edit": 1, "Caption Studio project": 1, recording: 1, guide: 1, "enhanced file": 1,
  "story split": 1, "context file": 1, "saved rewrite": 1, design: 1, "Content Analyzer account": 1, "saved post": 1, "idea board": 1,
  "social account": 1, "scheduled task": 1, folder: 1, "footage folder": 1, "Media Library clip": 1,
};

describe.skipIf(pluginWorkspaceStores().length > 0)("deleting a workspace", () => {
  it("counts what it holds, its member's work in it too, and deletes exactly that", async () => {
    const before = await contents(B);
    expect(counts(before)).toEqual({ ...ONE_EACH, memories: 2 }); // alex's and bo's
    expect(before.ownFiles).toBe(true);
    // only its owner deletes it
    expect((await call("bo", "DELETE", `/api/workshop/projects/${B}`)).status).toBe(404);
    expect((await call("alex", "DELETE", `/api/workshop/projects/${B}`)).status).toBe(200);

    for (const f of [...b.files, ...b.everywhere]) expect(existsSync(f), f).toBe(false);
    for (const f of [...a.files, ...a.everywhere]) expect(existsSync(f), f).toBe(true);
    const chats = JSON.parse(readFileSync(at("assistant", "alex.json"), "utf-8")) as { messages: unknown[]; past: { id: string }[] };
    expect([chats.messages.length, chats.past.map((c) => c.id)]).toEqual([0, ["chat-a"]]);
    const facts = (u: string) => (JSON.parse(readFileSync(at("memory", `${u}.json`), "utf-8")) as { facts: { id: string }[] }).facts.map((f) => f.id);
    expect(facts("alex")).toEqual(["fa", "fall"]);
    expect(facts("bo")).toEqual([]);
    const ids = (file: string, key = "id") => (JSON.parse(readFileSync(at(file), "utf-8")) as Record<string, string>[]).map((x) => x[key]);
    expect(ids("automations/alex.json")).toEqual(["ta", "tall"]);
    expect(ids("workshop/users/alex.edits.json", "key")).toEqual(["a", "all"]);
    expect(ids("review/notifications/alex.json")).toEqual(["na"]); // the bell of another workspace never shows B's
    const list = (file: string, field: string) => (JSON.parse(readFileSync(at(file), "utf-8")) as Record<string, Array<{ key?: string; id?: string }>>)[field]!.map((x) => x.key ?? x.id);
    expect(list("connectors/alex.json", "accounts")).toEqual(["youtube:a"]);
    expect(list("folders/notes/alex.json", "folders")).toEqual(["fa"]);
    expect(list("storage/alex.json", "folders")).toEqual(["sa"]);
    // B's library and its link go; the person's own file it pointed to stays
    const libs = (libraryDb().prepare("SELECT id FROM libraries").all() as { id: string }[]).map((r) => r.id);
    expect(libs).toEqual([lib.a]);
    expect(existsSync(at("library", "blobs", "libraries", lib.b))).toBe(false);
    expect(readFileSync(take, "utf-8")).toBe("the person's own video");
    // nothing of B's is left to count, and A's are all still there
    expect(counts(await contents(A))).toEqual({ ...ONE_EACH, memory: 1 });
  });

  it("the first brand takes its unstamped records with it; what is kept for every workspace stays", async () => {
    const loose = seed(undefined, "Old");
    const shown = counts(await contents(A));
    expect(shown["Caption Studio projects"]).toBe(2); // A's and the unstamped one: both show in A
    expect(shown.project).toBe(1);
    expect((await call("alex", "DELETE", `/api/workshop/projects/${A}`)).status).toBe(200);
    for (const f of [...a.files, ...a.everywhere, ...loose.files]) expect(existsSync(f), f).toBe(false);
    for (const f of loose.everywhere) expect(existsSync(f), f).toBe(true);
    const facts = (JSON.parse(readFileSync(at("memory", "alex.json"), "utf-8")) as { facts: { id: string }[] }).facts.map((f) => f.id);
    expect(facts).toEqual(["fall"]);
    expect(readFileSync(take, "utf-8")).toBe("the person's own video");
  });
});
