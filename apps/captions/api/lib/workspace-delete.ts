import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";
import { pluginWorkspaceStores, type WorkspaceStore } from "./plugin";
import { projectOf } from "./project-of";
import { workspaceOf } from "./workspaces";
import type { SessionUser } from "../users";
import type { WorkspaceContents } from "../../contracts/workspaces";

/**
 * Deleting a workspace deletes everything in it (owner, 2026-11-16: "all your chats and everything will be deleted with
 * this"). STORES is the one list of what a workspace holds: the delete confirm counts with it (workspaceContents) and the
 * delete removes with it (deleteWorkspaceContents), so the numbers shown are what goes. Each store deletes the app's own
 * files for its records (uploads, renders, proxies, share links); the person's own folders and the files a Media Library
 * indexes in place stay on disk.
 *
 * Which records are the workspace's (`has`, projectOf's rule, project-of.ts):
 * - stamped with its id;
 * - stamped with none, or with a workspace deleted before, when it is the first brand: that is where they showed, so
 *   deleting the first brand deletes them, and the next workspace never inherits them;
 * - a record that shows in every workspace (a session with no stamp, inProject; a memory, context file, task or folder
 *   kept for every workspace) is not its alone and stays. Those stores ask for a stamp first.
 * A team member the owner gave this workspace (Settings → Team) loses what they made in it: their records stamped with
 * its id. Their unstamped ones are their own first brand's and stay.
 *
 * Imported when used, as api/kept.ts does: the tools' modules would close an import loop through the routes.
 */

type Has = (stamp?: string) => boolean;
const stamped = (has: Has) => (s?: string) => !!s && has(s);
const json = (file: string) => readFile(file, "utf-8").then((s) => JSON.parse(s) as Record<string, unknown>, () => null);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const writeJson = async (file: string, data: unknown) => {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
};
const nothing = { n: 0, drop: async () => {} };

/** The account's records in a store of `<dir>/<id>/meta.json` folders (or `<dir>/<id>.json` files, `flat`) with `owner` and `projectId`. */
function metaStore(name: WorkspaceStore["name"], dir: string, o: { flat?: boolean; stop?: () => Promise<(id: string) => void> } = {}): WorkspaceStore {
  return {
    name,
    find: async (a, ws) => {
      const root = path.join(env.dataDir, dir);
      const hit: string[] = [];
      for (const n of await readdir(root).catch(() => [] as string[])) {
        if (o.flat && !n.endsWith(".json")) continue;
        const m = await json(o.flat ? path.join(root, n) : path.join(root, n, "meta.json"));
        // a record from before accounts is the admin's, as each tool lists it
        if (m && (m.owner === a.username || (a.role === "admin" && !m.owner)) && ws.has(str(m.projectId))) hit.push(n);
      }
      return {
        n: hit.length,
        drop: async () => {
          const stop = await o.stop?.();
          for (const n of hit) {
            stop?.(n);
            await rm(path.join(root, n), { recursive: true, force: true, maxRetries: 3 });
          }
        },
      };
    },
  };
}

/** The person's own folders: their entries go, the files in them stay (devices-storage.ts). */
const FOOTAGE_FOLDERS: WorkspaceStore = {
  name: ["footage folder", "footage folders"],
  ownFiles: true,
  find: async (a, ws) => (await import("../devices-storage")).workspaceStorageFolders(a.username, ws.has),
};

/** The workspace's Media Libraries, counted by their clips: the app's copies, proxies and index go; a file indexed in place stays. */
const LIBRARIES: WorkspaceStore = {
  name: ["Media Library clip", "Media Library clips"],
  ownFiles: true,
  find: async (a, ws) => {
    const { libraryDb } = await import("../library/db");
    const { homeOf } = await import("../library/access");
    const rows = libraryDb().prepare("SELECT id, json_extract(settings, '$.projectId') AS ws FROM libraries WHERE workspace_id = ?").all(homeOf(a.username)) as { id: string; ws: string | null }[];
    const ids = rows.filter((r) => ws.has(r.ws ?? undefined)).map((r) => r.id);
    const clips = libraryDb().prepare("SELECT id FROM assets WHERE library_id = ?");
    // a Review video is in its library under its own id: counted once, as a Review video
    const review = (id: string) => existsSync(path.join(env.dataDir, "review", id)) || existsSync(path.join(env.dataDir, "review", "trash", id));
    return {
      n: ids.reduce((n, id) => n + (clips.all(id) as { id: string }[]).filter((c) => !review(c.id)).length, 0),
      drop: async () => {
        const { deleteLibrary } = await import("../library/trash");
        for (const id of ids) await deleteLibrary(id);
      },
    };
  },
};

export const STORES: WorkspaceStore[] = [
  {
    // Content Workshop projects, with their pieces, drafts, pictures and deliveries (all in the session's folder)
    name: ["project", "projects"],
    find: async (a, ws) => {
      const root = path.join(env.dataDir, "workshop", "sessions");
      const hit: string[] = [];
      for (const id of await readdir(root).catch(() => [] as string[])) {
        const m = await json(path.join(root, id, "meta.json"));
        if (m?.owner === a.username && stamped(ws.has)(str(m.projectId))) hit.push(id);
      }
      return { n: hit.length, drop: () => Promise.all(hit.map((id) => rm(path.join(root, id), { recursive: true, force: true, maxRetries: 3 }))) };
    },
  },
  { name: ["chat", "chats"], find: async (a, ws) => (await import("../assistant")).workspaceChats(a.username, ws.has) },
  { name: ["Review video", "Review videos"], find: async (a, ws) => (await import("../review")).workspaceVideos(a.username, ws.has) },
  { name: ["Review folder", "Review folders"], find: async (a, ws) => (await import("../review")).workspaceFolders(a.username, ws.has) },
  {
    name: ["Editor edit", "Editor edits"],
    find: async (a, ws) => {
      const { allEdits, ownerOf, purgeEdit } = await import("../editor/store");
      const hit = allEdits().filter((e) => ownerOf(e) === a.username && ws.has(e.projectId));
      return {
        n: hit.length,
        drop: async () => {
          const { stopEdit } = await import("../editor/worker");
          for (const e of hit) {
            stopEdit(e.id);
            await purgeEdit(e.id);
          }
        },
      };
    },
  },
  { name: ["Caption Studio project", "Caption Studio projects"], find: async (a, ws) => (await import("../projects")).workspaceProjects(a, ws.has) },
  metaStore(["recording", "recordings"], "clips", { stop: async () => (await import("../clips")).cancel }),
  metaStore(["guide", "guides"], "documents"),
  metaStore(["enhanced file", "enhanced files"], "enhance", { stop: async () => (await import("../enhance")).cancel }),
  metaStore(["story split", "story splits"], "stories", { flat: true }),
  {
    name: ["context file", "context files"],
    find: async (a, ws) => {
      const root = path.join(env.dataDir, "workshop", "sources");
      const hit: string[] = [];
      for (const f of await readdir(root).catch(() => [] as string[])) {
        const m = f.endsWith(".json") ? await json(path.join(root, f)) : null;
        // one kept for every workspace has no stamp
        if (m?.owner === a.username && stamped(ws.has)(str(m.projectId))) hit.push(f.slice(0, -5));
      }
      return {
        n: hit.length,
        drop: async () => {
          for (const id of hit) for (const p of [`${id}.json`, `${id}.txt`, id]) await rm(path.join(root, p), { recursive: true, force: true });
        },
      };
    },
  },
  {
    // the writer's rewrites kept for this workspace's projects (one with no stamp teaches every workspace)
    name: ["saved rewrite", "saved rewrites"],
    find: async (a, ws) => {
      const file = path.join(env.dataDir, "workshop", "users", `${a.username}.edits.json`);
      const log = await readFile(file, "utf-8").then((s) => JSON.parse(s) as Array<{ projectId?: string }>, () => []);
      const n = log.filter((p) => p.projectId === ws.id).length;
      return { n, drop: async () => void (n && (await writeJson(file, log.filter((p) => p.projectId !== ws.id)))) };
    },
  },
  {
    // a design made from a Workshop piece is in that project's workspace (designs.ts listed)
    name: ["design", "designs"],
    find: async (a, ws) => {
      const root = path.join(env.dataDir, "designs", a.username);
      const hit: string[] = [];
      for (const f of await readdir(root).catch(() => [] as string[])) {
        const d = f.endsWith(".json") ? await json(path.join(root, f)) : null;
        const from = str((d?.from as { session?: unknown } | undefined)?.session);
        const session = from && /^[\w-]{1,64}$/.test(from) ? await json(path.join(env.dataDir, "workshop", "sessions", from, "meta.json")) : null;
        if (d && ws.has(str(session?.projectId) ?? str(d.project))) hit.push(f.slice(0, -5));
      }
      // each in its turn, as a design deleted by hand (a cut-out finishing meanwhile never brings it back)
      return { n: hit.length, drop: async () => {
        // (loaded when needed: the designs routes are a big module of their own)
        const { dropDesign } = await import("../designs");
        await Promise.all(hit.map((id) => dropDesign(a.username, id)));
      } };
    },
  },
  {
    name: ["carousel style", "carousel styles"],
    find: async (a, ws) => {
      const { deleteAnimation, stylesOf } = await import("../editor/animation-styles");
      const hit = stylesOf(a.username, "carousel").filter((s) => ws.has(s.projectId));
      return { n: hit.length, drop: async () => void (await Promise.all(hit.map((s) => deleteAnimation(a.username, s.id, "carousel")))) };
    },
  },
  { name: ["Content Analyzer account", "Content Analyzer accounts"], find: async (a, ws) => (await (await import("../instagram")).workspaceAnalyzer(a.username, ws.id)).accounts },
  { name: ["saved post", "saved posts"], find: async (a, ws) => (await (await import("../instagram")).workspaceAnalyzer(a.username, ws.id)).posts },
  { name: ["topic", "topics"], find: async (a, ws) => (await (await import("../instagram")).workspaceAnalyzer(a.username, ws.id)).topics },
  { name: ["idea board", "idea boards"], find: async (a, ws) => (await (await import("../instagram")).workspaceAnalyzer(a.username, ws.id)).board },
  {
    // a sign-in linked to this workspace; one linked to none stays
    name: ["social account", "social accounts"],
    find: async (a, ws) => {
      const { readConnectors, removeAccount } = await import("./connectors/store");
      const keys = readConnectors(a.username).accounts.filter((x) => x.projectId === ws.id).map((x) => x.key);
      return { n: keys.length, drop: async () => void keys.forEach((k) => removeAccount(a.username, k)) };
    },
  },
  // a memory, task or context file kept for every workspace has no stamp, and stays
  { name: ["memory rule", "memory rules"], find: async (a, ws) => (await import("./memory")).workspaceFacts(a.username, stamped(ws.has)) },
  { name: ["scheduled task", "scheduled tasks"], find: async (a, ws) => (await import("../automations")).workspaceTasks(a.username, stamped(ws.has)) },
  { name: ["folder", "folders"], find: async (a, ws) => (await import("../folders")).workspaceToolFolders(a.username, ws.has) },
  FOOTAGE_FOLDERS,
  LIBRARIES,
  // writing rules and frameworks kept to it alone go; a shared one only leaves its lists (lib/workshop/rule-workspaces.ts)
  ...([["rules", ["writing rule", "writing rules"]], ["frameworks", ["framework", "frameworks"]]] as const).map(
    ([kind, name]): WorkspaceStore => ({
      name: [...name],
      find: async (a, ws) => {
        const r = await import("./workshop/rule-workspaces");
        return { n: await r.keptOnlyTo(kind, a.username, ws.id), drop: () => r.dropWorkspaceFromRules(ws.id) };
      },
    }),
  ),
];

/** Every store: the app's own and the loaded plug-ins' (ServerPlugin.workspaceStores). */
const allStores = () => [...STORES, ...pluginWorkspaceStores()];

/**
 * What deleting `id` would delete, store by store: its owner's records (projectOf's rule) and those the team members
 * it was given made in it. Read while the workspace still exists: the first brand is worked out from it.
 */
async function plan(owner: SessionUser, id: string) {
  const of = await projectOf(owner);
  const team = workspaceOf(owner.username);
  const members = (team?.members ?? []).filter((m) => m.role !== "owner" && m.workspaces?.includes(id)).map((m) => ({ username: m.username, role: "user" }) as SessionUser);
  const who: Array<[SessionUser, Has]> = [[owner, (s) => (of ? of(s) === id : s === id)], ...members.map((m): [SessionUser, Has] => [m, (s) => s === id])];
  const out: Array<{ store: WorkspaceStore; found: Array<{ n: number; drop: () => Promise<unknown> }> }> = [];
  for (const store of allStores()) {
    const found = [];
    for (const [account, has] of who) found.push(await store.find(account, { id, has }).catch((e) => (console.error("[workspace-delete]", store.name[1], e), nothing)));
    out.push({ store, found });
  }
  return out;
}

/** The confirm's counts, each kind that has any ("5 chats"), and whether the person's own files are in it (they stay). */
export async function workspaceContents(owner: SessionUser, id: string): Promise<WorkspaceContents> {
  const counted = (await plan(owner, id)).map(({ store, found }) => ({ store, n: found.reduce((t, f) => t + f.n, 0) })).filter((x) => x.n > 0);
  return {
    items: counted.map(({ store, n }) => ({ n, what: n === 1 ? store.name[0] : store.name[1] })),
    ownFiles: counted.some((x) => x.store.ownFiles),
  };
}

/** Deletes everything in workspace `id`, before the workspace itself goes. A store that fails is logged; the rest carry on. */
export async function deleteWorkspaceContents(owner: SessionUser, id: string): Promise<void> {
  for (const { store, found } of await plan(owner, id)) for (const f of found) await f.drop().catch((e) => console.error("[workspace-delete]", store.name[1], e));
}
