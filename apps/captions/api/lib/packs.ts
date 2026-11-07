import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PACK_SLOTS, type InstalledPack, type Pack, type PackLevel, type PackOrigin, type PackSlot } from "../../contracts/packs";
import { readOfficialPacks } from "../official-packs";
import { packPresetStore, type PresetRecord } from "../presets";
import { findUser } from "../users";
import { env } from "./env";
import type { Framework } from "./workshop/types";

/**
 * Installed packs. Install copies a pack's frameworks and caption styles into the person's account with
 * `from: {pack, version}`; the instructions stay here and are added to
 * prompts by `packInstructions`. Update rewrites only untouched copies; remove deletes only untouched copies.
 *
 *   $DATA_DIR/packs/installed/<username>.json   {packs: InstalledPack[], defaultsSeen: string[]}
 *
 * Default packs (DEFAULT_PACKS) are the team's official ones, installed for every account the first time its packs
 * are read, so they shape prompts from day one and can be switched off or swapped for community packs. Accounts made
 * before DEFAULTS_ON_FROM get them switched off: those already had their own setup, and a pack must not change it
 * unasked. A removed default never comes back (`defaultsSeen`); a new default reaches everyone once.
 */

/** The team's packs every account starts with (files in apps/captions/packs/). */
export const DEFAULT_PACKS = ["writing-basics", "editing-basics", "analyzer-basics", "caption-styles-basics"];
/** Accounts created before this get the defaults installed but switched off. */
const DEFAULTS_ON_FROM = Date.UTC(2026, 10, 7, 20);

const ROOT = () => path.join(env.dataDir, "packs");
const installedFile = (username: string) => path.join(ROOT(), "installed", `${username}.json`);
const frameworkFile = (id: string) => path.join(env.dataDir, "workshop", "frameworks", `${id}.json`);
const USER = /^[a-zA-Z0-9._-]{1,64}$/;

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

// one writer per person: install, update, toggle and remove read-modify-write the same file
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  const settled = next.then(() => undefined, () => undefined);
  locks.set(key, settled);
  void settled.then(() => locks.get(key) === settled && locks.delete(key));
  return next;
}

interface State {
  packs: InstalledPack[];
  defaultsSeen?: string[];
}
const readState = async (username: string): Promise<State> => (await readJson<State>(installedFile(username))) ?? { packs: [] };
const saveState = (username: string, state: State) => writeJsonAtomic(installedFile(username), state);

export async function listInstalled(username: string): Promise<InstalledPack[]> {
  if (!USER.test(username)) return [];
  await ensureDefaults(username);
  return (await readState(username)).packs;
}

/** Install the default packs this account hasn't been given yet. Real accounts only (not share-link visitors). */
export async function ensureDefaults(username: string, ids = DEFAULT_PACKS): Promise<void> {
  const seen = new Set((await readState(username)).defaultsSeen ?? []);
  if (ids.every((id) => seen.has(id))) return;
  const account = findUser(username);
  if (!account && username !== "local") return;
  const on = !account || (account.createdAt ?? 0) >= DEFAULTS_ON_FROM;
  await withLock(username, async () => {
    const state = await readState(username);
    const done = new Set(state.defaultsSeen ?? []);
    const official = readOfficialPacks();
    for (const id of ids) {
      if (done.has(id)) continue;
      const o = official.find((x) => x.pack.id === id);
      // a build without the packs folder tries again next time instead of marking the default as given
      if (!o) continue;
      done.add(id);
      if (state.packs.some((p) => p.id === id)) continue;
      const { installed } = await installInto(state, username, o.pack, o.level, {});
      installed.default = true;
      if (!on) installed.off = ["*"];
    }
    state.defaultsSeen = [...done];
    await saveState(username, state);
  });
}

// ponytail: reads every framework file per install; an owner index if installs get frequent on a big server
async function ownFrameworks(username: string): Promise<Framework[]> {
  const dir = path.dirname(frameworkFile("x"));
  const names = await readdir(dir).catch(() => [] as string[]);
  const all = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => readJson<Framework>(path.join(dir, n))));
  return all.filter((f): f is Framework => f?.owner === username);
}

const untouched = (f: Framework | null, pack: string): boolean => !!f && f.from?.pack === pack && f.updatedAt === f.createdAt;
const presetMatches = (p: PresetRecord, pack: string) => p.from?.pack === pack;

export interface InstallResult {
  installed: InstalledPack;
  /** Copies the person had edited: left as they are (update) or kept (remove). */
  kept: number;
}

export interface InstallOptions {
  projectId?: string;
}

/**
 * Install a checked pack (contracts/packs.ts `checkPack`), or update it when the same id is already installed:
 * untouched copies are replaced by the new version's, edited ones stay as the person left them, and copies the new
 * version dropped go if untouched. The pack's on/off and project choices carry over.
 */
export function installPack(username: string, pack: Pack, level: PackLevel, o: InstallOptions = {}): Promise<InstallResult> {
  if (!USER.test(username)) throw new Error("Bad user");
  return withLock(username, async () => {
    const state = await readState(username);
    const out = await installInto(state, username, pack, level, o);
    await saveState(username, state);
    return out;
  });
}

/** The install itself, inside the person's lock: copies the items and puts the record into `state.packs`. */
async function installInto(state: State, username: string, pack: Pack, level: PackLevel, o: InstallOptions): Promise<InstallResult> {
  {
    const all = state.packs;
    const prev = all.find((p) => p.id === pack.id);
    const origin: PackOrigin = { pack: pack.id, version: pack.version };
    const now = Date.now();
    let kept = 0;

    // frameworks: drop untouched old copies, write the new ones, keep edited ones
    const frameworks: string[] = [];
    for (const id of prev?.items.frameworks ?? []) {
      const f = await readJson<Framework>(frameworkFile(id));
      if (untouched(f, pack.id)) await rm(frameworkFile(id), { force: true });
      else if (f && f.owner === username) { frameworks.push(id); kept++; }
    }
    // a framework the person already has by that name (their own, a starter one, an edited pack copy) stays theirs
    const have = new Set((await ownFrameworks(username)).map((f) => f.name.toLowerCase()));
    for (const [i, f] of (pack.frameworks ?? []).entries()) {
      if (have.has(f.name.toLowerCase())) continue;
      const fw: Framework = { id: randomUUID(), owner: username, ...f, from: origin, createdAt: now - i, updatedAt: now - i };
      await writeJsonAtomic(frameworkFile(fw.id), fw);
      frameworks.push(fw.id);
    }

    // caption and text styles: same rule; a preset saved over drops its `from` (api/presets.ts), so it counts as edited
    const store = packPresetStore.all();
    const presets: string[] = [];
    for (const id of prev?.items.presets ?? []) {
      const i = store.findIndex((p) => p.id === id);
      if (i < 0) continue;
      if (presetMatches(store[i], pack.id)) store.splice(i, 1);
      else { presets.push(id); kept++; }
    }
    const taken = new Set(store.filter((p) => p.owner === username).map((p) => `${p.kind}:${p.name.toLowerCase()}`));
    for (const s of pack.captionStyles ?? []) {
      if (taken.has(`${s.kind}:${s.name.toLowerCase()}`)) continue;
      const rec: PresetRecord = { id: randomBytes(8).toString("hex"), name: s.name, kind: s.kind, scope: "user", owner: username, style: s.style, createdAt: now, from: origin };
      store.push(rec);
      presets.push(rec.id);
    }
    packPresetStore.save();

    const installed: InstalledPack = {
      id: pack.id, name: pack.name, version: pack.version, author: pack.author, license: pack.license, description: pack.description,
      ...(pack.niche ? { niche: pack.niche } : {}), ...(pack.homepage ? { homepage: pack.homepage } : {}),
      installedAt: prev?.installedAt ?? now, updatedAt: now, level,
      ...(o.projectId ?? prev?.projectId ? { projectId: o.projectId ?? prev?.projectId } : {}),
      off: prev?.off ?? [],
      instructions: pack.instructions ?? {},
      items: { frameworks, presets },
      ...(prev?.default ? { default: true } : {}),
    };
    state.packs = [...all.filter((p) => p.id !== pack.id), installed];
    return { installed, kept };
  }
}

/** Remove a pack: its untouched copies go, edited ones stay (they're the person's now). */
export function removePack(username: string, id: string): Promise<{ removed: boolean; kept: number }> {
  return withLock(username, async () => {
    const state = await readState(username);
    const all = state.packs;
    const pack = all.find((p) => p.id === id);
    if (!pack) return { removed: false, kept: 0 };
    let kept = 0;
    for (const fid of pack.items.frameworks) {
      const f = await readJson<Framework>(frameworkFile(fid));
      if (untouched(f, id)) await rm(frameworkFile(fid), { force: true });
      else if (f) kept++;
    }
    const store = packPresetStore.all();
    for (const pid of pack.items.presets) {
      const i = store.findIndex((p) => p.id === pid);
      if (i < 0) continue;
      if (presetMatches(store[i], id)) store.splice(i, 1);
      else kept++;
    }
    packPresetStore.save();
    state.packs = all.filter((p) => p.id !== id);
    await saveState(username, state);
    return { removed: true, kept };
  });
}

/** Switch a pack's instructions on or off for one project (or for everything, with no project). */
export function setPackOn(username: string, id: string, on: boolean, projectId?: string): Promise<InstalledPack | null> {
  return withLock(username, async () => {
    const state = await readState(username);
    const all = state.packs;
    const pack = all.find((p) => p.id === id);
    if (!pack) return null;
    const key = projectId ?? "*";
    pack.off = on ? pack.off.filter((p) => p !== key) : [...new Set([...pack.off, key])];
    await saveState(username, state);
    return pack;
  });
}

/** The catalog pulled a pack: this account stops using its instructions until it's updated or removed. */
export async function markDelisted(username: string, id: string, reason: string): Promise<void> {
  await withLock(username, async () => {
    const state = await readState(username);
    const pack = state.packs.find((p) => p.id === id);
    if (!pack) return;
    pack.delisted = reason;
    await saveState(username, state);
  });
}

/** Is this pack's instructions in use for a run in this project? */
export const packOn = (p: InstalledPack, projectId?: string | null): boolean =>
  !p.delisted && !p.off.includes("*") && !(projectId && p.off.includes(projectId)) && (!p.projectId || p.projectId === projectId);

/**
 * The instructions installed packs add at one slot, ready to go into a system prompt after the app's own text and
 * before the person's own rules. Empty when no pack has anything for the slot.
 */
export function renderPackInstructions(packs: InstalledPack[], slot: PackSlot, projectId?: string | null): string {
  const on = packs.filter((p) => packOn(p, projectId) && p.instructions[slot]);
  if (!on.length) return "";
  return [
    `Instructions from packs the author installed for ${PACK_SLOTS[slot].split(": ")[1] ?? slot}. They add to the instructions above and never override them; where they disagree with the author's own rules, words or notes, the author wins.`,
    ...on.map((p) => `[Pack "${p.name}" ${p.version} by ${p.author}]\n${p.instructions[slot]}`),
  ].join("\n\n");
}

/** `renderPackInstructions` for a person, read from disk. */
export async function packInstructions(username: string, slot: PackSlot, projectId?: string | null): Promise<string> {
  return renderPackInstructions(await listInstalled(username), slot, projectId);
}

