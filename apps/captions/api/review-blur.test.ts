import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "./auth";

// A cut whose footage nobody has blurred yet (an editor files it with notBlurred): Review says so, only its owner
// approves it, as filmed, and in a workspace a plug-in serves (a footage store) no share link or download goes on for it.
const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "review-blur-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
const STORE = "eeeeeeee-0000-4000-8000-0000000000b1";
const OWN = "eeeeeeee-0000-4000-8000-0000000000b2";

const { reviewApp, addVersion, reviewJobsDone } = await import("./review");
const { inRequestWorkspace } = await import("./lib/workspace-scope");
const { workspaceScope } = await import("./lib/workshop/workspace");
// a plug-in that serves the STORE workspace's media itself (a footage catalog)
(await import("./lib/plugin")).mountPlugins(new Hono(), [{ id: "store", uploadsTo: async () => (workspaceScope.getStore()?.id === STORE ? "store" : null) }]);

mkdirSync(path.join(dataDir, "workshop", "projects"), { recursive: true });
for (const [id, at] of [[STORE, 1], [OWN, 2]] as const)
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
const cut = async (workspace: string, notBlurred: boolean, asset?: string) => {
  const added = await addVersion(asset, { owner: "ana", name: "Cut.mp4", mime: "video/mp4", bytes: 1, workspace, ...(notBlurred ? { notBlurred } : {}) }, async (dest) => writeFileSync(dest, "x"));
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
  expect((await json(no)).error).toBe("The faces in this cut aren't blurred. Approve it as filmed?");
  expect((await asset(id)).approval.status).toBe("none");
  // an admin who is not its owner, and a reviewer on its link (members, say): never, confirm or not
  expect((await approve({ asFilmed: true }, "root")).status).toBe(403);
  const link = await json(app.request(`/assets/${id}`, send("PATCH", { share: { enabled: true } })));
  const guest = await app.request(`/s/${link.share.token}/approval`, send("POST", { status: "approved", asFilmed: true }, "ben"));
  expect(guest.status).toBe(403);
  expect((await json(guest)).error).toBe("Only the owner can approve a cut whose faces aren't blurred");
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

it("turns no share link or download on for an unblurred cut where a plug-in serves the workspace; one already on stays", async () => {
  const id = await cut(STORE, false);
  const share = (s: Record<string, unknown>) => app.request(`/assets/${id}`, send("PATCH", { share: s }));
  expect((await share({ enabled: true })).status).toBe(200);
  await cut(STORE, true, id);
  for (const s of [{ enabled: true }, { download: true }]) {
    const r = await share(s);
    expect(r.status).toBe(409);
    expect((await json(r)).error).toBe("Blur the faces first: this cut uses clips the catalog hasn't blurred");
  }
  // the link that was on stays on (the page warns on it), and can still be turned off
  expect((await asset(id)).share).toMatchObject({ enabled: true, download: false });
  expect((await json(share({ enabled: false }))).share.enabled).toBe(false);
  // a project link with it in is refused too
  const project = await json(app.request("/projects", { ...send("POST", { name: "Shoot" }), headers: { "content-type": "application/json", "x-ct-workspace": STORE } }));
  await app.request(`/assets/${id}`, send("PATCH", { projectId: project.id }));
  expect((await app.request(`/projects/${project.id}`, send("PATCH", { share: { enabled: true } }))).status).toBe(409);
});

it("shares an unblurred cut as before outside a plug-in's workspace, and a blurred one everywhere", async () => {
  const mine = await cut(OWN, true);
  expect((await json(app.request(`/assets/${mine}`, send("PATCH", { share: { enabled: true, download: true } })))).share).toMatchObject({ enabled: true, download: true });
  const blurred = await cut(STORE, false);
  expect((await json(app.request(`/assets/${blurred}`, send("PATCH", { share: { enabled: true, download: true } })))).share).toMatchObject({ enabled: true, download: true });
  expect((await app.request(`/assets/${blurred}/approval`, send("POST", { status: "approved" }))).status).toBe(200);
});
