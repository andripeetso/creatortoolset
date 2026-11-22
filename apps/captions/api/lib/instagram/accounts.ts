import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SessionUser } from "../../users";
import { IG_ROOT } from "./base";
import { okId } from "../ids";
import type { AccountMeta } from "./types";

/**
 * The Analyzer's accounts as stored (instagram/accounts/<id>/meta.json), read without loading the Analyzer itself: the
 * modules that keep workspaces apart ask which account is the person's own (project-of.ts), and api/instagram.ts is a
 * big module with timers of its own (a first workspace read paid ~7 s to load it under a busy test run, 11-19).
 */
// read when called, never at load: this file sits in an import cycle (base.ts → users → … → project-of.ts → here),
// so IG_ROOT is not set yet while it loads
export const accountsRoot = () => path.join(IG_ROOT, "accounts");
export const accountDir = (id: string) => path.join(accountsRoot(), id);
export const accountMetaPath = (id: string) => path.join(accountDir(id), "meta.json");

/** Accounts being read right now, newer than their meta.json (api/instagram.ts keeps them here while a job runs). */
export const accountActive = new Map<string, AccountMeta>();

export async function readAccount(id: string): Promise<AccountMeta | null> {
  const mem = accountActive.get(id);
  if (mem) return mem;
  try {
    // A read never writes: a stale "processing" is reconciled once, at boot (resumeInterrupted).
    return JSON.parse(await readFile(accountMetaPath(id), "utf-8")) as AccountMeta;
  } catch {
    return null;
  }
}

export async function allAccountIds(): Promise<string[]> {
  try {
    return (await readdir(accountsRoot(), { withFileTypes: true }))
      .filter((d) => d.isDirectory() && okId(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export async function allAccounts(): Promise<AccountMeta[]> {
  const metas = await Promise.all((await allAccountIds()).map(readAccount));
  return metas.filter((m): m is AccountMeta => !!m);
}

/** The account the person marked as their own ("my account"), if any. "Mine" is per owner: the demo's copy of an
 *  account is never the admin's own. */
export const ownMine = (a: AccountMeta, user: SessionUser) => !!a.mine && a.owner === user.username;

export async function ownerMine(user: SessionUser): Promise<AccountMeta | null> {
  return (await allAccounts()).find((a) => ownMine(a, user)) ?? null;
}

/** The id of the account marked "my account" (the one Instagram login), if any. */
export const mineAccountId = async (user: SessionUser): Promise<string | undefined> => (await ownerMine(user))?.id;
