import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PACK_SLOTS, type InstalledPack, type Pack, type PackLevel, type PackOrigin, type PackSlot } from "../../contracts/packs";
import { packPresetStore, type PresetRecord } from "../presets";
import { env } from "./env";
import type { Framework } from "./workshop/types";

/**
 * Installed packs. Install copies a pack's frameworks and caption styles into the person's account with
 * `from: {pack, version}`; the instructions stay here and are added to
 * prompts by `packInstructions`. Update rewrites only untouched copies; remove deletes only untouched copies.
 *
 *   $DATA_DIR/packs/installed/<username>.json   {packs: InstalledPack[]}
 */

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

export async function listInstalled(username: string): Promise<InstalledPack[]> {
  if (!USER.test(username)) return [];
  return (await readJson<{ packs: InstalledPack[] }>(installedFile(username)))?.packs ?? [];
}

const saveInstalled = (username: string, packs: InstalledPack[]) => writeJsonAtomic(installedFile(username), { packs });

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
    const all = await listInstalled(username);
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
    };
    await saveInstalled(username, [...all.filter((p) => p.id !== pack.id), installed]);
    return { installed, kept };
  });
}

/** Remove a pack: its untouched copies go, edited ones stay (they're the person's now). */
export function removePack(username: string, id: string): Promise<{ removed: boolean; kept: number }> {
  return withLock(username, async () => {
    const all = await listInstalled(username);
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
    await saveInstalled(username, all.filter((p) => p.id !== id));
    return { removed: true, kept };
  });
}

/** Switch a pack's instructions on or off for one project (or for everything, with no project). */
export function setPackOn(username: string, id: string, on: boolean, projectId?: string): Promise<InstalledPack | null> {
  return withLock(username, async () => {
    const all = await listInstalled(username);
    const pack = all.find((p) => p.id === id);
    if (!pack) return null;
    const key = projectId ?? "*";
    pack.off = on ? pack.off.filter((p) => p !== key) : [...new Set([...pack.off, key])];
    await saveInstalled(username, all);
    return pack;
  });
}

/** Is this pack's instructions in use for a run in this project? */
export const packOn = (p: InstalledPack, projectId?: string | null): boolean =>
  !p.off.includes("*") && !(projectId && p.off.includes(projectId)) && (!p.projectId || p.projectId === projectId);

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

