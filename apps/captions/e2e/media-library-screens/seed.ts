// Seeds a scratch DATA_DIR for the Media Library on-screen check: a "Tiny Acrobatics" workspace with an owner and a
// member, one library with no setupAt (the setup dialog opens itself), and one set up with a few synthetic clips.
// Run by run.mjs with SEED_DATA_DIR set: `npx vite-node e2e/media-library-screens/seed.ts`. Never touches real footage.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const OWNER = { username: "owner", password: "owner-pass-1" };
export const MEMBER = { username: "member", password: "member-pass-1" };
export const WORKSPACE_NAME = "Tiny Acrobatics";

const data = process.env.SEED_DATA_DIR;
if (!data) throw new Error("SEED_DATA_DIR is not set");
process.env.DATA_DIR = data;
process.env.APP_SECRET = process.env.APP_SECRET || "screens-secret-123";
// the workspace's owner is the seeded owner: api/lib/workspaces.ts migrate() makes the admin named here the owner of the first workspace
process.env.ADMIN_USERNAME = OWNER.username;
mkdirSync(data, { recursive: true });

const { createUser, findUser, setPassword } = await import("../../api/users");
const { workspaceOf, renameWorkspace, addMember, updateMember } = await import("../../api/lib/workspaces");
const { libraryDb, blobs } = await import("../../api/library/db");
const { probe } = await import("../../api/library/media/probe");
const { indexAsset } = await import("../../api/library/query");

// the bootstrap makes the ADMIN_USERNAME account with the APP_SECRET as its password: the owner's own is set here
if (!findUser(OWNER.username)) createUser(OWNER.username, OWNER.password, { role: "admin" });
setPassword(findUser(OWNER.username)!, OWNER.password);
if (!findUser(MEMBER.username)) createUser(MEMBER.username, MEMBER.password);
const w = workspaceOf(OWNER.username);
if (!w) throw new Error("the owner has no workspace: check how a new account gets one (api/lib/workspaces.ts)");
renameWorkspace(w, WORKSPACE_NAME);
addMember(w, MEMBER.username);
// The shared workspace: the owner's Workshop project (the Settings → Team row the app writes), given to the member. The
// workspace routes exist only on a hosted server, so the seed writes them with the app's own modules; the member then
// switches to it through the app's workspace route (run.mjs).
// the workspace's own owner: sharedWith reads the owner by it
const wsOwner = w.members.find((m) => m.role === "owner")!.username;
if (wsOwner !== OWNER.username) throw new Error(`the workspace's owner is ${wsOwner}, not the seeded owner`);
const shared = randomUUID();
const now = Date.now();
mkdirSync(path.join(data, "workshop", "projects"), { recursive: true });
writeFileSync(path.join(data, "workshop", "projects", `${shared}.json`), JSON.stringify({ id: shared, owner: wsOwner, name: WORKSPACE_NAME, audience: "", voice: "", cta: "", notes: "", knowledge: [], createdAt: now, updatedAt: now }));
updateMember(w, MEMBER.username, "owner", { workspaces: [shared] });

const d = libraryDb();
// Library 1: never set up. Library 2: set up, with three synthetic clips (ffmpeg test pattern, 4 s each).
d.prepare("INSERT OR IGNORE INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_fresh', ?, 'Fresh library', 'local', '{}', 0)").run(w.id);
const set = JSON.stringify({ setupAt: "2026-11-18T09:00:00.000Z" });
d.prepare("INSERT OR IGNORE INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_ready', ?, 'Tiny Acrobatics library', 'local', ?, 0)").run(w.id, set);

if (!d.prepare("SELECT 1 FROM assets WHERE id = 'ast_clip1'").get()) {
  const fixture = path.join(data, "take.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=360x640:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", fixture]);
  for (const n of [1, 2, 3]) {
    const key = `libraries/lib_ready/v/ver_clip${n}/source`;
    const p = await probe(fixture);
    const put = path.join(data, `put${n}.mp4`);
    copyFileSync(fixture, put);
    await blobs.put(key, put);
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_ready', 'video', ?, ?, ?, 0)").run(`ast_clip${n}`, `Tiny Acrobatics take ${n}`, `ver_clip${n}`, OWNER.username);
    d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, 'video/mp4', ?, 'ready', ?, 0)").run(`ver_clip${n}`, `ast_clip${n}`, key, `sha-clip-${n}`, JSON.stringify(p), OWNER.username);
    indexAsset(d, `ast_clip${n}`);
  }
}
// The owner's three folders in one Library folder on their Mac (Settings → Media Library's Folders, D1 of the 11-19
// sign-off): written as the app keeps them, since a server not on that Mac refuses to read a Source media folder there
const { changeStorage } = await import("../../api/devices-storage");
await changeStorage(OWNER.username, (st) => {
  if (st.folders.some((f) => f.id === "fold_footage")) return "keep";
  for (const [role, name] of [["footage", "FOOTAGE"], ["projects", "Project files"], ["library", "EXPORTS"]] as const)
    st.folders.push({ id: `fold_${role}`, role, name, origin: { host: "mac-tiny", path: `/Volumes/Tiny/Library/${name}` }, make: false, createdAt: now, reach: {}, workspace: "*" } as never);
});
console.log(JSON.stringify({ seeded: data, workspace: w.id, shared, owner: OWNER.username, member: MEMBER.username }));
