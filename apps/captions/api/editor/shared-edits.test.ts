import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Edit, EditSummary } from "../../contracts/editor";
import type { Pack } from "../../contracts/packs";

// Edits are shared in their workspace (store.ts editRole): everyone the team's owner gave it sees every edit there with
// its maker, anyone with Read & write makes the next version as themselves, renaming and the trash are the maker's and
// the owner's, and the grade, styles and context are the workspace's. ana owns the team; bo and dee (Read) are given
// FIRST, cy is in the team with no workspace, eve is not in it.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-shared-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-shared-test-secret";
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FIRST = "cccccccc-0000-4000-8000-000000000001";
const SECOND = "cccccccc-0000-4000-8000-000000000002";
mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
for (const [id, at] of [[FIRST, 1], [SECOND, 2]] as const) {
  writeFileSync(path.join(dir, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner: "ana", name: `Tiny Acrobatics ${at}`, notes: `Keep brand ${at} playful`, createdAt: at, updatedAt: at }));
}
const member = (username: string, workspaces?: string[]) => ({ username, role: "member", ai: "own", budgetUsd: 0, joinedAt: 0, ...(workspaces ? { workspaces } : {}) });
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({
    workspaces: [{ id: "t", name: "Team", plan: "team", comped: false, createdAt: 0, members: [{ ...member("ana"), role: "owner" }, member("bo", [FIRST]), member("cy"), member("dee", [FIRST])] }],
    invites: [],
    spend: {},
  }),
);

const { createUser, findUser, setOff, setRead } = await import("../users");
const app = (await import("../boot")).default;
const rootReplaced = (await import("../lib/plugin")).pluginReplaces("/api/editor");
const { libraryDb } = await import("../library/db");
const { installPack } = await import("../lib/packs");
const { STEPS, tick } = await import("./worker");
const { createEdit, gradeOf, ownerOf, readEdit, setChosenDefault } = await import("./store");
const { workspaceSetup } = await import("./plan");

const cookies: Record<string, string> = {};
async function login(username: string) {
  setOff(createUser(username, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { cookie: cookies[user]!, "content-type": "application/json", "x-ct-workspace": FIRST }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async <T = any>(r: Response | Promise<Response>): Promise<T> => (await r).json() as Promise<T>;
const make = async (user: string, sources: string[], projectId = FIRST) => (await json<{ id: string }>(call(user, "POST", "/api/editor", { name: `${user}'s cut`, sources, projectId }))).id;
const listed = async (user: string) => (await json<EditSummary[]>(call(user, "GET", "/api/editor"))).map((e) => e.id).sort();
const drain = async () => {
  while (await tick(10 ** 13));
};

const warm = { slope: [1.05, 1, 0.95], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 } as const;
const looks: Pack = { format: 1, id: "tiny-looks", name: "Tiny looks", version: "1.0.0", author: "tinyacrobatics", license: "CC0-1.0", description: "A grade.", permissions: ["grade"], grades: [{ name: "warm", title: "Warm", cdl: { ...warm, slope: [...warm.slope], offset: [...warm.offset], power: [...warm.power] } }] };

let anas = "";
let anasOther = "";
let bos = "";

beforeAll(async () => {
  for (const u of ["ana", "bo", "cy", "dee", "eve"]) await login(u);
  setRead(findUser("dee")!, ["editor"]);
  // ana's libraries carry her team's id (homeOf): one in each of her workspaces
  libraryDb().exec(`
    INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES
      ('lib_one', 't', 'One', 'local', '{"projectId":"${FIRST}"}', 0), ('lib_two', 't', 'Two', 'local', '{"projectId":"${SECOND}"}', 1);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_1', 'lib_one', 'video', 'Take 1', 'ana', 0), ('ast_2', 'lib_two', 'video', 'Take 2', 'ana', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES
      ('ver_1', 'ast_1', 1, 'k1', 1, 'x1', 'ready', 'ana', 0), ('ver_2', 'ast_2', 1, 'k2', 1, 'x2', 'ready', 'ana', 0);
  `);
  // the workspace's grade: ana's pack, ana's default; bo has neither
  await installPack("ana", looks, 0);
  await setChosenDefault("ana", "grade", "warm");
  anas = await make("ana", ["ver_1"]);
  anasOther = await make("ana", ["ver_2"], SECOND);
  bos = await make("bo", ["ver_1"]);
});

describe.skipIf(rootReplaced)("AI Editor: edits shared in their workspace", () => {
  it("a member with Read & write makes an edit from the given workspace's footage, there only, with the workspace's grade", async () => {
    expect(bos).toBeTruthy();
    const e = await json<Edit>(call("bo", "GET", `/api/editor/${bos}`));
    expect(e).toMatchObject({ createdBy: "bo", workspaceId: "t", maker: { name: "bo" } });
    expect(e.bundle.grade).toBe("warm");
    expect(ownerOf(readEdit(bos)!)).toBe("ana");
    expect(await gradeOf(ownerOf(readEdit(bos)!), e.bundle)).toEqual(looks.grades![0]!.cdl);
    // footage of a workspace not given, or a teammate given none: 404
    expect((await call("bo", "POST", "/api/editor", { sources: ["ver_2"], projectId: FIRST })).status).toBe(404);
    expect((await call("cy", "POST", "/api/editor", { sources: ["ver_1"] })).status).toBe(404);
    // the given workspace's footage makes an edit in that workspace only, never one filed elsewhere
    expect(await createEdit("bo", { sources: ["ver_1"] }, false, SECOND)).toBeNull();
    expect(await createEdit("bo", { sources: ["ver_1"] })).toBeNull();
  });

  it("the workspace's instructions reach an edit a member started", async () => {
    expect(await workspaceSetup(readEdit(bos)!, 4000)).toContain("Keep brand 1 playful");
  });

  it("everyone given the workspace sees every edit there, with its maker; nobody else sees any", async () => {
    expect(await listed("bo")).toEqual([anas, bos].sort());
    expect(await listed("dee")).toEqual([anas, bos].sort());
    expect(await listed("ana")).toEqual([anas, anasOther, bos].sort());
    const list = await json<EditSummary[]>(call("ana", "GET", "/api/editor"));
    expect(list.find((e) => e.id === bos)).toMatchObject({ projectId: FIRST, maker: { name: "bo" } });
    expect(list.find((e) => e.id === anasOther)).toMatchObject({ projectId: SECOND, maker: { name: "ana" } });
    expect((await json<EditSummary[]>(call("bo", "GET", "/api/editor"))).every((e) => e.projectId === FIRST)).toBe(true);
    expect((await call("bo", "GET", `/api/editor/${anasOther}`)).status).toBe(404);
    for (const u of ["cy", "eve"]) {
      expect(await listed(u)).toEqual([]);
      expect((await call(u, "GET", `/api/editor/${anas}`)).status).toBe(404);
      expect((await call(u, "POST", `/api/editor/${anas}/run`, {})).status).toBe(404);
    }
  });

  it("a member makes the next version of the owner's edit, each step run as them; Read opens it and changes nothing", async () => {
    const seen: string[] = [];
    const real = STEPS.analyze;
    STEPS.analyze = async ({ job }) => void seen.push(`analyze:${job.actor}`);
    try {
      expect((await call("bo", "POST", `/api/editor/${anas}/run`, { from: "analyze" })).status).toBe(200);
      await drain();
      expect(seen).toEqual(["analyze:bo"]);
      expect((await call("bo", "POST", `/api/editor/${anas}/feedback`, { text: "Shorter, please" })).status).toBe(200);
      const asked = libraryDb().prepare("SELECT actor FROM edit_jobs WHERE edit_id = ? ORDER BY id DESC LIMIT 1").get(anas) as { actor: string };
      expect(asked.actor).toBe("bo");
      await drain();
      expect(seen).toEqual(["analyze:bo", "analyze:bo"]);
    } finally {
      STEPS.analyze = real!;
    }
    expect((await call("dee", "GET", `/api/editor/${anas}`)).status).toBe(200);
    expect((await call("dee", "POST", `/api/editor/${anas}/run`, {})).status).toBe(403);
    expect((await call("dee", "POST", "/api/editor", { sources: ["ver_1"], projectId: FIRST })).status).toBe(403);
  });

  it("a teammate taken off the workspace no longer reaches its edits, and their queued step fails", async () => {
    const real = STEPS.analyze;
    STEPS.analyze = async () => {};
    const { updateMember, workspaceOf } = await import("../lib/workspaces");
    try {
      await call("bo", "POST", `/api/editor/${anas}/run`, { from: "analyze" });
      updateMember(workspaceOf("ana")!, "bo", "owner", { workspaces: [] });
      await drain();
      expect((await json<Edit>(call("ana", "GET", `/api/editor/${anas}`))).jobs.find((j) => j.kind === "analyze")).toMatchObject({ state: "failed", error: expect.stringMatching(/no longer yours/) });
      expect(await listed("bo")).toEqual([]);
    } finally {
      updateMember(workspaceOf("ana")!, "bo", "owner", { workspaces: [FIRST] });
      STEPS.analyze = real!;
    }
  });

  it("only the maker or the workspace's owner renames an edit or moves it to the trash", async () => {
    expect((await json<Edit>(call("bo", "GET", `/api/editor/${anas}`))).locked).toBe(true);
    expect((await json<Edit>(call("bo", "GET", `/api/editor/${bos}`))).locked).toBeUndefined();
    expect((await json<Edit>(call("ana", "GET", `/api/editor/${bos}`))).locked).toBeUndefined();
    expect((await call("bo", "PATCH", `/api/editor/${anas}`, { name: "Mine now" })).status).toBe(403);
    expect((await call("bo", "PATCH", `/api/editor/${anas}`, { brief: "Faster start" })).status).toBe(200);
    expect((await call("bo", "DELETE", `/api/editor/${anas}`)).status).toBe(403);
    expect(readEdit(anas)).toMatchObject({ name: "ana's cut", brief: "Faster start" });
    expect((await call("bo", "PATCH", `/api/editor/${bos}`, { name: "Bo's first" })).status).toBe(200);
    expect((await call("ana", "PATCH", `/api/editor/${bos}`, { name: "Bo's hook" })).status).toBe(200);
    expect((await call("ana", "DELETE", `/api/editor/${bos}`)).status).toBe(200);
    expect(await listed("bo")).toEqual([anas]);
    bos = await make("bo", ["ver_1"]);
  });

  it("a teammate's preview filed in the owner's Review plays on the edit page for everyone who sees the edit", async () => {
    const asset = "cccccccc-0000-4000-8000-0000000000aa";
    mkdirSync(path.join(dir, "review", asset), { recursive: true });
    const version = { n: 1, name: "bo's cut v1.mp4", mime: "video/mp4", bytes: 1, duration: 1, fps: 30, width: 1, height: 1, status: "processing", progress: 0, createdAt: 0, draft: { edit: bos, name: "v1", by: "bo" } };
    writeFileSync(path.join(dir, "review", asset, "meta.json"), JSON.stringify({ id: asset, name: "bo's cut v1.mp4", owner: "ana", versions: [version], approval: { status: "needs_review" }, createdAt: 0, updatedAt: 0 }));
    const play = (u: string) => call(u, "GET", `/api/review/assets/${asset}/v/1/play`);
    // seen (not ready yet: 409) by the owner, the maker and a reader of the workspace; nobody else
    for (const u of ["ana", "bo", "dee"]) expect((await play(u)).status).toBe(409);
    for (const u of ["cy", "eve"]) expect((await play(u)).status).toBe(404);
  });
});

describe.skipIf(rootReplaced)("AI Editor: the defaults are each workspace's own", () => {
  const THIRD = "cccccccc-0000-4000-8000-000000000003";
  const at = (ws: string, method = "GET", slot = "", body?: unknown) =>
    app.request(`/api/editor/defaults${slot}`, { method, headers: { cookie: cookies.ana!, "content-type": "application/json", "x-ct-workspace": ws }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const grade = async (r: Response | Promise<Response>) => (await json(r)).bundle.grade;

  it("what was chosen before starts every workspace she has; a change in one leaves the other, and a new edit takes its own workspace's", async () => {
    // ana chose Warm before the defaults were per workspace (beforeAll): both her workspaces start with it
    expect(await grade(at(FIRST))).toBe("warm");
    expect(await grade(at(SECOND))).toBe("warm");
    expect(await grade(at(SECOND, "PUT", "/grade", { id: null }))).toBe("none");
    expect(await grade(at(FIRST))).toBe("warm");
    expect(readEdit(await make("ana", ["ver_2"], SECOND))!.bundle.grade).toBe("none");
    expect(readEdit(await make("ana", ["ver_1"], FIRST))!.bundle.grade).toBe("warm");
  });

  it("a workspace made later starts from the app's defaults", async () => {
    writeFileSync(path.join(dir, "workshop", "projects", `${THIRD}.json`), JSON.stringify({ id: THIRD, owner: "ana", name: "Tiny Acrobatics 3", createdAt: 3, updatedAt: 3 }));
    const d = await json(at(THIRD));
    expect(d.chosen).toEqual({});
    expect(d.bundle.grade).toBe("none");
  });
});
