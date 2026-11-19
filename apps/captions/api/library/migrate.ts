import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LOOK_BUDGET_DEFAULT, type LibrarySettings, type WatchFolder } from "../../contracts/library";
import { EVERY_WORKSPACE, THIS_COMPUTER, folderIn, type StorageFolder } from "../../contracts/storage";
import { isThisMachine, listDevices } from "../lib/devices";
import { env } from "../lib/env";
import { macUsageSince, type UsageTally } from "../lib/mac-claude";
import { migrateStorage, parseStorageFile, storageFilePath } from "../lib/storage";
import { changeStorage } from "../devices-storage";
import { LOCAL_USER, listUsers } from "../users";
import { accountOf, ensureLibrary } from "./access";
import { DESCRIBE_LABEL, libraryWorkspaceId } from "./describe";
import { libraryDb, uploadOf } from "./db";
import { LISTEN_LABEL, LOOK_LABEL, WATCH_LABEL } from "./shots";
import { hasMembers } from "./upload-gate";
import { resolveDevice } from "./whereis";

/** One change the migration makes, or in a dry run would make. A folder's `to` is the line the hand-off shows. */
export interface MigrationChange {
  libraryId: string;
  field: "setupAt" | "upload" | "lookBudget" | "folder";
  from: unknown;
  to: unknown;
}

/** A file a Mac indexed that no listed Source media row covers: reported, never dropped (§4.6 item 2). */
export interface Outside {
  libraryId: string;
  versionId: string;
  device: string;
  path: string;
}

export interface MigrationResult {
  changes: MigrationChange[];
  outside: Outside[];
  /** what stays as it is and the hand-off names (Finals watches, copy folders, collections) */
  notes: string[];
  /** set when the one-time migration already ran here: nothing is changed */
  skipped?: string;
}

/** The host of a folder whose computer no account has: the page says "Computer not found" for it (§4.6 item 1). */
export const NOT_FOUND = "not-found";
const MARK = "4.6";
const DAY = 86_400_000;
/** The spend the monthly budget counts (§4.5): shot descriptions, the video breakdown, sound listens and describe. */
const SPEND = [LOOK_LABEL, `${LOOK_LABEL} (API)`, WATCH_LABEL, LISTEN_LABEL, DESCRIBE_LABEL, `${DESCRIBE_LABEL} (API)`];

type Raw = Partial<LibrarySettings> & { watch?: WatchFolder[] };
interface Seen {
  versionId: string;
  device: string;
  path: string;
  /** a verified place or a Mac's own index: the invariant covers it */
  must: boolean;
}
interface Lib {
  id: string;
  name: string;
  /** the account whose folder list the library's rows go in */
  account: string;
  ws?: string;
  s: Raw;
  hasClips: boolean;
  seen: Seen[];
}

/** Whether `p` is `root` or inside it. A root "~/…" is a Mac's home folder, so it matches the same folder under any home. */
export function under(p: string, root: string): boolean {
  const r = root.replace(/\/+$/, "");
  if (r.startsWith("~/")) {
    const rest = r.slice(2);
    return p.includes(`/${rest}/`) || p.endsWith(`/${rest}`);
  }
  return p === r || p.startsWith(`${r}/`);
}

/** The computers that indexed files under `root`, one row each; none = []. */
const hostsUnder = (seen: Seen[], root: string): string[] => [...new Set(seen.filter((x) => under(x.path, root)).map((x) => x.device))];

/** The server's own computer for an account (the paired one it runs on), else the schema's name for it. */
const hereOf = (user: string): string => listDevices((d) => d.owner === user && isThisMachine(d.id))[0]?.id ?? THIS_COMPUTER;

/** The account's list as the migration reads it, without writing it (readStorage writes a schema move back itself). */
async function listOf(user: string): Promise<StorageFolder[]> {
  const raw = await readFile(storageFilePath(env.dataDir, user), "utf-8").catch(() => "{}");
  return migrateStorage(parseStorageFile(raw), hereOf(user), resolveDevice).st.folders;
}

/** Every library's settings, clips and the Macs' files, read once. Files with no computer are NOT_FOUND, never dropped. */
function factsOf(): Lib[] {
  const db = libraryDb();
  const rows = db
    .prepare(
      `SELECT l.id, l.workspace_id AS home, l.name, COALESCE(l.settings, '{}') AS settings,
         EXISTS (SELECT 1 FROM assets a WHERE a.library_id = l.id) AS hasClips
       FROM libraries l`,
    )
    .all() as { id: string; home: string; name: string; settings: string; hasClips: number }[];
  const seenOf = db.prepare(
    `SELECT v.id AS versionId, COALESCE(v.mac_device, '${NOT_FOUND}') AS device, v.mac_path AS path, 1 AS must
       FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND v.mac_path IS NOT NULL
     UNION ALL
     SELECT vp.version_id, vp.device, vp.path, vp.state = 'verified' FROM version_places vp
       JOIN asset_versions v ON v.id = vp.version_id JOIN assets a ON a.id = v.asset_id
       WHERE a.library_id = ? AND vp.kind = 'original'`,
  );
  return rows.map((r) => {
    const s = JSON.parse(r.settings) as Raw;
    const seen = (seenOf.all(r.id, r.id) as { versionId: string; device: string; path: string; must: number }[]).map((x) => ({ ...x, must: !!x.must }));
    return { id: r.id, name: r.name, account: accountOf(r.home) ?? r.home, ws: s.projectId, s, hasClips: !!r.hasClips, seen };
  });
}

export interface FolderPlan {
  folders: StorageFolder[];
  changes: MigrationChange[];
  outside: Outside[];
  notes: string[];
}

/**
 * Items 1 and 2 on one account's list (pure, so the dry run and the write share it). Copy roots go FIRST: one Source media row
 * per computer that indexed files under the root, or a NOT_FOUND row when a stored copyTo has none. Watch folders and in-place
 * places follow the rows there are. A row already listed (same computer, same path) is kept, so a second run adds nothing.
 */
export function planFolders(folders: StorageFolder[], libs: Lib[], here: string, now: number): FolderPlan {
  const front: StorageFolder[] = [];
  const back: StorageFolder[] = [];
  const changes: MigrationChange[] = [];
  const notes: string[] = [];
  const add = (into: StorageFolder[], lib: Lib, host: string, p: string, make: boolean, line: string) => {
    if ([...folders, ...front, ...back].some((f) => f.origin.host === host && f.origin.path === p)) return;
    into.push({ id: randomUUID(), role: "footage", name: path.basename(p) || p, origin: { host, path: p }, make, createdAt: now, reach: {}, ...(lib.ws ? { workspace: lib.ws } : {}) });
    changes.push({ libraryId: lib.id, field: "folder", from: null, to: line });
  };
  const label = (host: string) => (host === NOT_FOUND ? "Computer not found" : host);
  for (const lib of libs) {
    const root = lib.s.copyTo ?? `~/Movies/Creator Toolset/${lib.name}`;
    const hosts = hostsUnder(lib.seen, root);
    for (const h of hosts.length ? hosts : lib.s.copyTo ? [NOT_FOUND] : [])
      add(front, lib, h, root, true, `Source media on ${label(h)}: ${root} (first: added files go here)`);
    for (const w of lib.s.watch ?? []) {
      if (w.projects) {
        notes.push(`${lib.id}: ${w.path} is a Finals folder; it stays in settings.watch until the Final exports record carries its projects`);
        continue;
      }
      if (w.collectionId) notes.push(`${lib.id}: ${w.path} was filed into a collection; its new files are no longer filed automatically`);
      if (w.mode === "copy") notes.push(`${lib.id}: ${w.path} was a copy folder; its files stay where they are`);
      add(back, lib, here, w.path, false, `Source media on this server: ${w.path}`);
    }
    for (const p of lib.s.places ?? []) {
      // a copy place's files went into the copy root, which has its row above
      if (p.mode === "copy") {
        notes.push(`${lib.id}: ${p.path} was a copy place; its files were copied into the copy root`);
        continue;
      }
      const hosts = hostsUnder(lib.seen, p.path);
      for (const h of hosts.length ? hosts : [NOT_FOUND]) add(back, lib, h, p.path, false, `Source media on ${label(h)}: ${p.path}`);
    }
  }
  const next = [...front, ...folders, ...back];
  const covered = (host: string, p: string) => next.some((f) => f.role === "footage" && f.origin.host === host && under(p, f.origin.path));
  const outside: Outside[] = [];
  for (const lib of libs)
    for (const x of lib.seen) if (x.must && !covered(x.device, x.path)) outside.push({ libraryId: lib.id, versionId: x.versionId, device: x.device, path: x.path });
  return { folders: next, changes, outside, notes };
}

/** Items 3, 4 and 6 on the library rows. Convergent: a second run changes nothing. A dry run lists every change and writes none. */
export async function migrateLibraries(opts: { dryRun?: boolean; now?: string } = {}): Promise<MigrationChange[]> {
  const db = libraryDb();
  const nowIso = opts.now ?? new Date().toISOString();
  const usage = await macUsageSince(Date.parse(nowIso) - 30 * DAY);
  const lists = new Map<string, StorageFolder[]>();
  const changes: MigrationChange[] = [];
  for (const lib of factsOf()) {
    const s = lib.s;
    if (!lists.has(lib.account)) lists.set(lib.account, await listOf(lib.account));
    const mine = lists.get(lib.account)!.filter((f) => folderIn(f, lib.ws ? (w) => w === lib.ws : null));
    // item 3: a library with clips or folder records is set up, so nobody who works today sees setup
    if (s.setupAt == null && (lib.hasClips || (s.watch?.length ?? 0) > 0 || mine.length > 0))
      changes.push({ libraryId: lib.id, field: "setupAt", from: null, to: nowIso });
    // item 4: a shared library that keeps no Hosted media takes the team's proxies (a legacy false or a null reads as none)
    const upload = s.upload as unknown;
    if (uploadOf(upload) === "none" && (await hasMembers(lib.id)))
      changes.push({ libraryId: lib.id, field: "upload", from: upload === false ? 0 : (upload ?? null), to: "proxies" });
    // item 6: at or over the cap (stored, else the default; a stored null is no cap), the cap becomes 1.5× the last 30 days' spend
    const cap = "lookBudget" in s ? s.lookBudget : LOOK_BUDGET_DEFAULT;
    if (typeof cap === "number") {
      const spent = spendIn(usage, await libraryWorkspaceId(db, lib.id));
      const next = Math.ceil(spent * 1.5);
      if (spent >= cap && next > cap) changes.push({ libraryId: lib.id, field: "lookBudget", from: cap, to: next });
    }
  }
  if (!opts.dryRun)
    for (const c of changes)
      if (c.field !== "folder")
        db.prepare(`UPDATE libraries SET settings = json_set(COALESCE(settings, '{}'), '$.${c.field}', ?) WHERE id = ?`).run(c.to as string | number, c.libraryId);
  return changes;
}

/** What the workspace spent in the tally's hours (all workspaces when undefined), by the labels the budget counts. */
function spendIn(usage: UsageTally, ws?: string): number {
  let usd = 0;
  for (const labels of Object.values(usage))
    for (const l of SPEND) {
      const t = labels[l];
      usd += (ws ? t?.ws?.[ws]?.costUsd : t?.costUsd) ?? 0;
    }
  return usd;
}

const markFile = () => path.join(env.dataDir, "library", "migrated.json");
function markedAt(): string | undefined {
  try {
    return (JSON.parse(readFileSync(markFile(), "utf-8")) as Record<string, string>)[MARK];
  } catch {
    return undefined;
  }
}

/**
 * The whole one-time migration (§4.6), at boot. It runs once per data folder: the marker says so, because items 4 and 6 would
 * otherwise undo an owner's later choice at every restart. Order: the folder rows (items 1, 2), a setup for each workspace that
 * has folder records and no library (item 3), then the library rows (items 3, 4, 6). `dryRun` lists every change and writes none.
 */
export async function migrateOnce(opts: { dryRun?: boolean; now?: string } = {}): Promise<MigrationResult> {
  const nowIso = opts.now ?? new Date().toISOString();
  const done = markedAt();
  if (done) return { changes: [], outside: [], notes: [], skipped: `already migrated at ${done}` };
  const now = Date.parse(nowIso);
  const libs = factsOf();
  const accounts = [...new Set([...listUsers().map((u) => u.username), LOCAL_USER.username, ...libs.map((l) => l.account)])];
  const out: MigrationResult = { changes: [], outside: [], notes: [] };
  const setups: { account: string; ws: string }[] = [];
  for (const account of accounts) {
    const mine = libs.filter((l) => l.account === account);
    const here = hereOf(account);
    let plan!: FolderPlan;
    if (opts.dryRun) plan = planFolders(await listOf(account), mine, here, now);
    else
      await changeStorage(account, (st) => {
        plan = planFolders(st.folders, mine, here, now);
        if (!plan.changes.length) return "keep";
        st.folders = plan.folders;
      });
    out.changes.push(...plan.changes);
    out.outside.push(...plan.outside);
    out.notes.push(...plan.notes);
    for (const f of plan.folders)
      for (const ws of f.workspaces ?? [f.workspace]) {
        if (!ws || ws === EVERY_WORKSPACE || mine.some((l) => l.ws === ws) || setups.some((x) => x.account === account && x.ws === ws)) continue;
        setups.push({ account, ws });
      }
  }
  for (const { account, ws } of setups) {
    const id = opts.dryRun ? `(new library in ${ws})` : await ensureLibrary(account, ws);
    if (!id) {
      out.notes.push(`workspace ${ws} of ${account}: no library could be made (Media Library off); its setup is not written`);
      continue;
    }
    if (!opts.dryRun) libraryDb().prepare(`UPDATE libraries SET settings = json_set(COALESCE(settings, '{}'), '$.setupAt', ?) WHERE id = ?`).run(nowIso, id);
    out.changes.push({ libraryId: id, field: "setupAt", from: null, to: nowIso });
  }
  out.changes.push(...(await migrateLibraries({ dryRun: opts.dryRun, now: nowIso })));
  if (!opts.dryRun) {
    mkdirSync(path.dirname(markFile()), { recursive: true });
    writeFileSync(markFile(), JSON.stringify({ [MARK]: nowIso }));
  }
  return out;
}
