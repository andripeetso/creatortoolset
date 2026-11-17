/**
 * Item 7A: whether this server does video work (PRD 4.5, design 7). Video work is a step that decodes video or sound:
 * the AI Editor's steps placed on a computer (engine.ts `place`) and the library's DECODES. A server always stores,
 * serves, syncs, keeps the queue, reads a file's header, runs the steps that read no video and makes the card pictures;
 * where its video work is off, the rest waits with its one line until one of the asker's computers takes it, and never
 * falls through to the server.
 *
 * - This Mac (CT_LOCAL=1): no switch, the server is the person's computer: always on.
 * - Creator Toolset Cloud (CT_MODE=hosted): off, unless a plug-in's `serverWork` grants it for the account (7C).
 * - Any other server: Settings → Server, the admin: `$DATA_DIR/server-work.json { on, projectIds? }` (no list = every
 *   workspace). No file = off: the work runs on each person's own computers unless the admin turns it on. The first start
 *   of this version writes it off once on every server (settleServerWork), saying so in Settings → Server where it was on.
 * - Each workspace's owner picks whether it uses the server where it is allowed (the Workshop project's `serverWork`,
 *   missing = yes).
 * - Each person's Load balancing has a row for the server (balance weight SERVER_PLACE): Prefer sends work there first,
 *   Off never; Normal and Less often leave it to their computers first, as before.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_WEIGHT, type Balance } from "../../contracts/providers";
import { balanceFile } from "../lib/balance";
import { env, hostedMode } from "../lib/env";
import { pluginServerWork } from "../lib/plugin";
import { libraryDb } from "../library/db";
import { listUsers } from "../users";

export interface ServerWork {
  on: boolean;
  /** only these workspaces (Workshop project ids); missing = every workspace */
  projectIds?: string[];
  /** the version of the rule the file was written under (VERSION) */
  v?: number;
  /** this version's first start turned it off (it was on): Settings → Server says so until the admin changes it */
  offByUpdate?: boolean;
}

/** 2: off by default on every server, existing ones included (local-first plan, decision 4). */
const VERSION = 2;

/** The server's key in a person's load balancing weights (Balance.weights), beside their computers' ids. */
export const SERVER_PLACE = "server";
/** Prefer (contracts/providers.ts LOAD_PREFERENCES). */
const PREFER = 100;

export type ServerKind = "local" | "hosted" | "server";
export const serverKind = (): ServerKind => (hostedMode() ? "hosted" : process.env.CT_LOCAL === "1" ? "local" : "server");

const file = () => path.join(env.dataDir, "server-work.json");
const ID = /^[\w-]{1,100}$/;
const projectFile = (id: string) => path.join(env.dataDir, "workshop", "projects", `${id}.json`);

// read per queued job on every idle tick of both loops: parsed again only when the file changed
const memo = new Map<string, { stamp: string; v: unknown }>();
function readJson<T>(f: string): T | null {
  const st = statSync(f, { throwIfNoEntry: false });
  if (!st) return null;
  const stamp = `${st.ino}:${st.mtimeMs}:${st.size}`;
  const m = memo.get(f);
  if (m?.stamp === stamp) return m.v as T | null;
  let v: T | null = null;
  try {
    v = JSON.parse(readFileSync(f, "utf8")) as T;
  } catch {
    // half-written: as none
  }
  memo.set(f, { stamp, v });
  return v;
}

/** The admin's setting as saved; null = never saved (off). */
export const readServerWork = (): ServerWork | null => readJson<ServerWork>(file());

export function writeServerWork(s: ServerWork): ServerWork {
  const out: ServerWork = { on: !!s.on, ...(s.projectIds ? { projectIds: [...new Set(s.projectIds)] } : {}), v: VERSION, ...(s.offByUpdate ? { offByUpdate: true } : {}) };
  mkdirSync(env.dataDir, { recursive: true });
  const tmp = `${file()}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(out));
  renameSync(tmp, file());
  return out;
}

/**
 * The first start of this version: video work off on every server, existing ones included; the work runs on each person's
 * own computers. A server where it was on (its file, or no file on a server in use: no file was on before) says so once in
 * Settings → Server. The workspace list is kept for when the admin turns it on. Written once; This Mac and the Cloud have no file.
 */
export function settleServerWork(): void {
  if (serverKind() !== "server") return;
  const s = readServerWork();
  if (s?.v === VERSION) return;
  // a new server has only the admin it made itself (users.ts), never signed in to
  const used = () => {
    const users = listUsers();
    return users.length > 1 || users.some((u) => u.usage.lastActiveAt > 0) || !!libraryDb().prepare("SELECT 1 FROM assets LIMIT 1").get();
  };
  writeServerWork({ on: false, ...(s?.projectIds ? { projectIds: s.projectIds } : {}), offByUpdate: s ? s.on : used() });
}

/** Whether the server lets video work run on it for `workspace` (a Workshop project id; none = filed in no workspace), asked by `account`. */
export function serverAllows(workspace: string | null | undefined, account: string | null): boolean {
  const kind = serverKind();
  if (kind === "local") return true;
  const grant = pluginServerWork({ account, workspace: workspace ?? null });
  if (kind === "hosted") return grant === true;
  if (grant !== undefined) return grant;
  const s = readServerWork();
  if (!s) return false;
  // ponytail: a thing filed in no workspace (from before workspaces) counts only under All workspaces
  return s.on && (!s.projectIds || (!!workspace && s.projectIds.includes(workspace)));
}

/** The workspace owner's choice: also this server where it allows (missing, the default), or its computers only. */
export const workspaceUsesServer = (workspace: string | null | undefined): boolean =>
  !workspace || !ID.test(workspace) || readJson<{ serverWork?: boolean }>(projectFile(workspace))?.serverWork !== false;

/** Whether this server's loops may run video work for `workspace`, asked by `account`. */
export const serverWorks = (workspace: string | null | undefined, account: string | null): boolean =>
  serverAllows(workspace, account) && (serverKind() === "local" || workspaceUsesServer(workspace));

/** The person's Load balancing weight for this server (DEFAULT_WEIGHT unless set; balancing off = Normal). This Mac has no row. */
export function serverWeight(account: string | null): number {
  if (!account || serverKind() === "local") return DEFAULT_WEIGHT;
  const b = readJson<Partial<Balance>>(balanceFile(account));
  const w = b?.on === false ? undefined : b?.weights?.[SERVER_PLACE];
  return typeof w === "number" ? w : DEFAULT_WEIGHT;
}

/** The person set the server to Prefer, and it may work here. */
export const serverPreferred = (workspace: string | null | undefined, account: string | null): boolean =>
  serverKind() !== "local" && serverWeight(account) >= PREFER && serverWorks(workspace, account);

/** The workspace an edit's step is in (its Workshop project). */
// the edit's own file (editor/store.ts), read here directly: the library's loop imports this file, and the editor's store
// leads back to it
export function stepWorkspace(versionId: string | null): string | null {
  const id = (versionId ?? "").split(":")[0]!;
  return ID.test(id) ? (readJson<{ projectId?: string }>(path.join(env.dataDir, "editor", id, "edit.json"))?.projectId ?? null) : null;
}

/** The workspace a library job is in (its library's project). */
export function libraryWorkspace(libraryId: string): string | null {
  const r = libraryDb().prepare("SELECT json_extract(settings, '$.projectId') AS ws FROM libraries WHERE id = ?").get(libraryId) as { ws: string | null } | undefined;
  return r?.ws ?? null;
}
