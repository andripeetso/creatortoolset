import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "./auth";

// The Review bell shows the workspace the person is in (owner, 2026-11-16: "It should be the current workspace"), its
// unread count too; a note from before notes named a workspace goes by its video's.
const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "review-inbox-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const A = "bbbbbbbb-0000-4000-8000-000000000001"; // the first brand
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const put = (file: string, data: unknown) => (mkdirSync(path.dirname(file), { recursive: true }), writeFileSync(file, JSON.stringify(data)));
for (const [id, createdAt] of [[A, 1], [B, 2]] as const)
  put(path.join(dataDir, "workshop", "projects", `${id}.json`), { id, owner: "alex", name: id, audience: "", voice: "", cta: "", notes: "", createdAt, updatedAt: createdAt });
const OLD_VIDEO = "aaaaaaaa-0000-4000-8000-000000000001"; // B's, from before notes named a workspace
put(path.join(dataDir, "review", OLD_VIDEO, "meta.json"), { id: OLD_VIDEO, owner: "alex", name: "Old cut", versions: [], approval: { status: "none" }, createdAt: 1, updatedAt: 1, workspace: B });
const note = (id: string, assetId: string, workspace?: string) => ({ id, kind: "comment", by: "Ada", assetId, name: id, href: "/", at: 1, ...(workspace ? { workspace } : {}) });
put(path.join(dataDir, "review", "notifications", "alex.json"), [
  note("in-a", "aaaaaaaa-0000-4000-8000-00000000000a", A),
  note("in-b", "aaaaaaaa-0000-4000-8000-00000000000b", B),
  note("old-b", OLD_VIDEO),
  note("old-unknown", "cccccccc-0000-4000-8000-000000000001"), // its record is gone: the first brand's
]);

const { reviewApp, notifyWorkshopOwner } = await import("./review");
const { inRequestWorkspace } = await import("./lib/workspace-scope");
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "alex", role: "user", cloud: false, off: [] } as never);
  await next();
});
app.use("*", inRequestWorkspace);
app.route("/", reviewApp);

const inbox = async (ws: string) => (await (await app.request("/notifications", { headers: { "x-ct-workspace": ws } })).json()) as { items: { id: string }[]; unread: number };
const ids = async (ws: string) => (await inbox(ws)).items.map((x) => x.id);

it("lists and counts only the current workspace's notes", async () => {
  expect(await ids(A)).toEqual(["in-a", "old-unknown"]);
  expect(await ids(B)).toEqual(["in-b", "old-b"]);
  expect((await inbox(A)).unread).toBe(2);

  // a new note names its workspace
  await notifyWorkshopOwner("alex", { kind: "workshop", by: "Content Workshop", name: "Reel", href: "/workshop", ref: "s1", workspace: B });
  const [fresh, ...rest] = await ids(B);
  expect(rest).toEqual(["in-b", "old-b"]);
  expect(await ids(A)).not.toContain(fresh);

  // Mark all read in B leaves A's unread
  await app.request("/notifications/read", { method: "POST", headers: { "content-type": "application/json", "x-ct-workspace": B }, body: "{}" });
  expect([(await inbox(B)).unread, (await inbox(A)).unread]).toEqual([0, 2]);
});
