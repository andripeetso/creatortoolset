import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

// A cut whose footage nobody has blurred yet (an editor files it with notBlurred): Review says so, only its owner
// approves it, as filmed, and in a workspace with Blur faces on no share link or download goes on for it. Under Blur faces
// Review keeps only a cut its filer blurred (upload-gate.ts mayLeave).
const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "review-blur-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
const STORE = "eeeeeeee-0000-4000-8000-0000000000b1";
const OWN = "eeeeeeee-0000-4000-8000-0000000000b2";
// a workspace a plug-in serves itself (a footage store, the studio's catalog), with no Blur faces of its own yet
const PLUGGED = "eeeeeeee-0000-4000-8000-0000000000b3";

const { reviewApp, addVersion, reviewJobsDone } = await import("./review");
const { inRequestWorkspace } = await import("./lib/workspace-scope");
const { libraryDb } = await import("./library/db");
const { REFUSED_BLUR } = await import("./library/upload-gate");
const { workspaceScope } = await import("./lib/workshop/workspace");
(await import("./lib/plugin")).mountPlugins(new Hono(), [{ id: "store", uploadsTo: async () => (workspaceScope.getStore()?.id === PLUGGED ? "store" : null) }]);
// the STORE workspace's Media Library, whose Blur faces each test turns on or off
libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_store', 'ana', 'Library', 'local', ?, 0)").run(JSON.stringify({ projectId: STORE, upload: "none" }));
const blurFaces = (on: boolean) => libraryDb().prepare("UPDATE libraries SET settings = json_set(settings, '$.blurFaces', json(?)) WHERE id = 'lib_store'").run(on ? "true" : "false");

mkdirSync(path.join(dataDir, "workshop", "projects"), { recursive: true });
for (const [id, at] of [[STORE, 1], [OWN, 2], [PLUGGED, 3]] as const)
  writeFileSync(path.join(dataDir, "workshop", "projects", `${id}.json`), JSON.stringify({ id, owner: "ana", name: id, createdAt: at, updatedAt: at }));

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  const who = c.req.header("x-as") ?? "ana";
  c.set("user", { username: who, role: who === "root" ? "admin" : "user", cloud: false, off: [] });
  await next();
});
app.use("*", inRequestWorkspace);
app.route("/", reviewApp);

const send = (method: string, body: unknown, who = "ana"): RequestInit => ({
  method,
  headers: { "content-type": "application/json", "x-as": who },
  body: JSON.stringify(body),
});
const cut = async (workspace: string, notBlurred: boolean, asset?: string, blurred = !notBlurred) => {
  const added = await addVersion(asset, { owner: "ana", name: "Cut.mp4", mime: "video/mp4", bytes: 1, workspace, ...(notBlurred ? { notBlurred } : {}), blurred }, async (dest) => writeFileSync(dest, "x"));
  await reviewJobsDone();
  return added!.meta.id;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const asset = async (id: string) => (await json(app.request(`/assets/${id}`))).asset;

it("files an unblurred cut with its state: Review gets it on the version", async () => {
  const id = await cut(OWN, true);
  expect((await asset(id)).versions[0]).toMatchObject({ notBlurred: true });
  expect((await asset(await cut(OWN, false))).versions[0].notBlurred).toBeUndefined();
});

it("approves an unblurred cut only from its owner, as filmed", async () => {
  const id = await cut(OWN, true);
  const approve = (body: Record<string, unknown>, who?: string) => app.request(`/assets/${id}/approval`, send("POST", { status: "approved", ...body }, who));
  const no = await approve({});
  expect(no.status).toBe(409);
  expect(await json(no)).toEqual({ error: "The faces in this cut aren't blurred. Approve it as filmed?", code: "not_blurred" });
  expect((await asset(id)).approval.status).toBe("none");
  // an admin who is not its owner, and a reviewer on its link (members, say): never, confirm or not
  const admin = await approve({ asFilmed: true }, "root");
  expect(admin.status).toBe(403);
  expect(await json(admin)).toEqual({ error: "Only the owner can approve a cut whose faces aren't blurred", code: "owner_only" });
  const link = await json(app.request(`/assets/${id}`, send("PATCH", { share: { enabled: true } })));
  const guest = await app.request(`/s/${link.share.token}/approval`, send("POST", { status: "approved", asFilmed: true }, "ben"));
  expect(guest.status).toBe(403);
  expect(await json(guest)).toEqual({ error: "Only the owner can approve a cut whose faces aren't blurred", code: "owner_only" });
  expect((await asset(id)).approval.status).toBe("none");
  // the owner's confirm: approved, as filmed, with who and when
  expect((await approve({ asFilmed: true })).status).toBe(200);
  const after = await asset(id);
  expect(after.approval).toMatchObject({ status: "approved", by: "ana" });
  expect(after.versions[0].approvedAsFilmed).toMatchObject({ by: "ana", at: expect.any(Number) });
  // a later round's approval needs no new confirm; a new unblurred version does
  await app.request(`/assets/${id}/approval`, send("POST", { status: "changes" }));
  expect((await approve({})).status).toBe(200);
  await cut(OWN, true, id);
  expect((await approve({})).status).toBe(409);
  // a blurred re-cut is approved as any version is
  await cut(OWN, false, id);
  expect((await approve({})).status).toBe(200);
});

it("turns no share link or download on for an unblurred cut once Blur faces is on; one already on stays", async () => {
  const id = await cut(STORE, false);
  const share = (s: Record<string, unknown>) => app.request(`/assets/${id}`, send("PATCH", { share: s }));
  expect((await share({ enabled: true })).status).toBe(200);
  // filed before Blur faces was on (under it, it would not be kept at all: the next test)
  await cut(STORE, true, id);
  blurFaces(true);
  for (const s of [{ enabled: true }, { download: true }]) {
    const r = await share(s);
    expect(r.status).toBe(409);
    expect((await json(r)).error).toBe("Blur the faces first: this cut uses clips that aren't blurred yet");
  }
  // the link that was on stays on (the page warns on it), and can still be turned off; under Blur faces it shows nothing
  // of a video with a version not filed as blurred, while its owner still watches it
  const on = (await asset(id)).share;
  expect(on).toMatchObject({ enabled: true, download: false });
  expect((await app.request(`/s/${on.token}`, { headers: { "x-as": "ben" } })).status).toBe(404);
  expect((await app.request(`/assets/${id}`)).status).toBe(200);
  expect((await json(share({ enabled: false }))).share.enabled).toBe(false);
  // a project link with it in is refused too
  const project = await json(app.request("/projects", { ...send("POST", { name: "Shoot" }), headers: { "content-type": "application/json", "x-ct-workspace": STORE } }));
  await app.request(`/assets/${id}`, send("PATCH", { projectId: project.id }));
  expect((await app.request(`/projects/${project.id}`, send("PATCH", { share: { enabled: true } }))).status).toBe(409);
  blurFaces(false);
});

it("turns no share link or download on for an unblurred cut where a plug-in serves the workspace, Blur faces or not; one already on stays", async () => {
  const id = await cut(PLUGGED, false);
  const share = (s: Record<string, unknown>) => app.request(`/assets/${id}`, send("PATCH", { share: s }));
  expect((await share({ enabled: true })).status).toBe(200);
  await cut(PLUGGED, true, id);
  for (const s of [{ enabled: true }, { download: true }]) {
    const r = await share(s);
    expect(r.status).toBe(409);
    expect((await json(r)).error).toBe("Blur the faces first: this cut uses clips that aren't blurred yet");
  }
  expect((await asset(id)).share).toMatchObject({ enabled: true, download: false });
  const project = await json(app.request("/projects", { ...send("POST", { name: "Shoot" }), headers: { "content-type": "application/json", "x-ct-workspace": PLUGGED } }));
  await app.request(`/assets/${id}`, send("PATCH", { projectId: project.id }));
  expect((await app.request(`/projects/${project.id}`, send("PATCH", { share: { enabled: true } }))).status).toBe(409);
});

it("under Blur faces a video filed before it with no word on its faces is neither shared nor shown on its link", async () => {
  const id = await cut(STORE, false, undefined, false);
  const share = (s: Record<string, unknown>) => app.request(`/assets/${id}`, send("PATCH", { share: s }));
  const token = (await json(share({ enabled: true }))).share.token;
  expect((await app.request(`/s/${token}`, { headers: { "x-as": "ben" } })).status).toBe(200);
  blurFaces(true);
  try {
    expect((await app.request(`/s/${token}`, { headers: { "x-as": "ben" } })).status).toBe(404);
    expect((await share({ download: true })).status).toBe(409);
    // a blurred cut's video is shared as before
    const kept = await cut(STORE, false);
    expect((await asset(kept)).versions[0].blurred).toBe(true);
    const t2 = (await json(app.request(`/assets/${kept}`, send("PATCH", { share: { enabled: true, download: true } })))).share.token;
    expect((await app.request(`/s/${t2}`, { headers: { "x-as": "ben" } })).status).toBe(200);
  } finally {
    blurFaces(false);
  }
});

it("an AI card's signed link shows a version under Blur faces only when it was filed as blurred", async () => {
  const { reviewVersionLeaves } = await import("./review");
  const old = await cut(STORE, false, undefined, false);
  const fine = await cut(STORE, false);
  expect(await reviewVersionLeaves(old, 1)).toBe(true);
  blurFaces(true);
  try {
    expect(await reviewVersionLeaves(old, 1)).toBe(false);
    expect(await reviewVersionLeaves(fine, 1)).toBe(true);
    expect(await reviewVersionLeaves(fine, 2)).toBe(false); // no such version
  } finally {
    blurFaces(false);
  }
});

it("keeps only a cut its filer blurred under Blur faces: an unblurred one, one that says nothing and a browser's upload are refused", async () => {
  blurFaces(true);
  try {
    await expect(cut(STORE, true)).rejects.toThrow(REFUSED_BLUR);
    await expect(cut(STORE, false, undefined, false)).rejects.toThrow(REFUSED_BLUR);
    const kept = await cut(STORE, false);
    expect((await asset(kept)).versions).toHaveLength(1);
    // a next version of a kept cut follows its workspace too
    await expect(cut(OWN, true, kept)).rejects.toThrow(REFUSED_BLUR);
    const up = await app.request("/uploads", { ...send("POST", { size: 4, name: "Cut.mp4" }), headers: { "content-type": "application/json", "x-ct-workspace": STORE } });
    expect(up.status).toBe(409);
    expect((await json(up)).message).toBe(REFUSED_BLUR);
    // another workspace of the same owner keeps its own rules
    expect(await cut(OWN, true)).toBeTruthy();
  } finally {
    blurFaces(false);
  }
});

it("shares an unblurred cut as before where Blur faces is off, and a blurred one everywhere", async () => {
  const mine = await cut(OWN, true);
  expect((await json(app.request(`/assets/${mine}`, send("PATCH", { share: { enabled: true, download: true } })))).share).toMatchObject({ enabled: true, download: true });
  const blurred = await cut(STORE, false);
  expect((await json(app.request(`/assets/${blurred}`, send("PATCH", { share: { enabled: true, download: true } })))).share).toMatchObject({ enabled: true, download: true });
  expect((await app.request(`/assets/${blurred}/approval`, send("POST", { status: "approved" }))).status).toBe(200);
});

it("under Blur faces a teammate who may see the edit sees an as-filmed cut; a share link to it is refused", async () => {
  blurFaces(true);
  try {
    const added = await addVersion(undefined, { owner: "ana", name: "Team cut.mp4", mime: "video/mp4", bytes: 1, workspace: STORE, asFilmed: true, draft: { edit: "e_team", name: "v1" } }, async (dest) => writeFileSync(dest, "x"));
    await reviewJobsDone();
    const id = added!.meta.id;
    const v = (await asset(id)).versions[0];
    expect(v.asFilmed).toBe(true);
    expect(v.blurred).toBeUndefined(); // as filmed is never called blurred
    // ben may see the edit it is made from (editor/store.ts editRole, seesEdit)
    vi.doMock("./editor/store", async (orig) => ({ ...(await orig<object>()), readEdit: () => ({ id: "e_team" }), editRole: async () => "member", seesEdit: async () => true }));
    try {
      expect((await app.request(`/assets/${id}`, { headers: { "x-as": "ben" } })).status).toBe(200);
    } finally {
      vi.doUnmock("./editor/store");
    }
    // a share link is public: only a blurred cut goes out on one
    const r = await app.request(`/assets/${id}`, send("PATCH", { share: { enabled: true } }));
    expect(r.status).toBe(409);
  } finally {
    blurFaces(false);
  }
});

it("under Blur faces a share link serves no picture of a removed version that was not filed as blurred", async () => {
  const id = await cut(STORE, false, undefined, false); // filed before Blur faces, with nothing said for it
  await cut(STORE, false, id); // a blurred next version
  const thumb = (n: number) => path.join(dataDir, "review", id, `v${n}`, "thumb.jpg");
  for (const n of [1, 2]) {
    mkdirSync(path.dirname(thumb(n)), { recursive: true });
    writeFileSync(thumb(n), "jpeg");
  }
  const link = await json(app.request(`/assets/${id}`, send("PATCH", { share: { enabled: true } })));
  expect((await app.request(`/assets/${id}/v/2/clear-earlier`, send("POST", {}))).status).toBe(200);
  writeFileSync(thumb(1), "jpeg"); // a still left behind
  blurFaces(true);
  try {
    expect((await app.request(`/s/${link.share.token}/v/2/thumb`, { headers: { "x-as": "ben" } })).status).toBe(200);
    expect((await app.request(`/s/${link.share.token}/v/1/thumb`, { headers: { "x-as": "ben" } })).status).toBe(404);
  } finally {
    blurFaces(false);
  }
});
