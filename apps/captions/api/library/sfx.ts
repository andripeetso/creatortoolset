import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { AuthVars } from "../auth";
import { SOUNDS } from "../../contracts/library";
import { SFX_TYPES, type SfxManifest, type SfxSound, type SfxType } from "../../contracts/sfx";
import { ensureLibrary, librariesHere, libraryRole } from "./access";
import { libraryDb } from "./db";
import { saveToLibrary } from "./routes";
import { nameWords } from "./sfx-type";

// The shipped CC0 sound effects (public/sfx, or dist/public/sfx once built) and the Media Library's Sound effects folder.
// A sound the app adds goes in with the same ingest as a dropped one (saveToLibrary, sound "effect"): its tag keeps the
// AI off it, its source and licence go in asset_sources, its type goes in as a tag. Installing twice adds nothing twice:
// saveToLibrary answers a file the library already has.

const EFFECT = SOUNDS.effect.tag;
const TYPE_TAGS = new Set<string>(SFX_TYPES);
const dirs = [path.resolve(import.meta.dirname, "../../dist/public/sfx"), path.resolve(import.meta.dirname, "../../public/sfx")];

export function sfxDir(): string | null {
  return dirs.find((d) => existsSync(path.join(d, "manifest.json"))) ?? null;
}

let cached: SfxManifest | null = null;
/** The shipped catalog. Read once per process: the files change only with a new build. */
export function catalog(): SfxManifest {
  if (!cached) {
    const dir = sfxDir();
    cached = dir ? (JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as SfxManifest) : { packs: [], sounds: [] };
  }
  return cached;
}

const starter = () => catalog().sounds.filter((s) => s.starter);

/** The Sound effects folder of one library (the plain top-level one, made by the library the first time it is needed). */
function folderOf(lib: string): string | null {
  const r = libraryDb()
    .prepare("SELECT id FROM collections WHERE library_id = ? AND parent_id IS NULL AND kind = 'manual' AND name = ? ORDER BY created_at, id LIMIT 1")
    .get(lib, SOUNDS.effect.folder) as { id: string } | undefined;
  return r?.id ?? null;
}

/** The live sound effects of one library, with the sha256 of each one's current file. */
function liveSounds(lib: string): { id: string; title: string; sha: string }[] {
  return libraryDb()
    .prepare(
      `SELECT a.id AS id, a.title AS title, v.sha256 AS sha FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id AND t.tag = ?)`,
    )
    .all(lib, EFFECT) as { id: string; title: string; sha: string }[];
}

/** The library of the workspace this request is in, the one this account may write to (null: none). */
async function ownLibrary(username: string): Promise<string | null> {
  const made = await ensureLibrary(username);
  if (made && libraryRole(username, made)) return made;
  return (await librariesHere(username)).find((l) => libraryRole(username, l.id))?.id ?? null;
}

/** Puts each sound into the library's Sound effects folder with its type, source and licence. */
async function addSounds(username: string, lib: string, list: SfxSound[]): Promise<{ added: SfxSound[]; already: number; failed: number; waiting?: string }> {
  const out: { added: SfxSound[]; already: number; failed: number; waiting?: string } = { added: [], already: 0, failed: 0 };
  const dir = sfxDir();
  const db = libraryDb();
  for (const s of list) {
    if (!dir) {
      out.failed++;
      continue;
    }
    const r = await saveToLibrary(username, path.join(dir, s.file), `${s.title}.m4a`, [], lib, false, "effect");
    if (r && "assetId" in r) {
      db.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag, source) VALUES (?, ?, 'ai')").run(r.assetId, s.type);
      db.prepare("INSERT OR IGNORE INTO asset_sources (asset_id, url, license, author, at) VALUES (?, ?, ?, ?, ?)").run(r.assetId, s.source, s.license, s.author, Date.now());
      out.added.push(s);
    } else if (r && "duplicateOf" in r) out.already++;
    // Upload none: on its way to their computer's Source media folder, or waiting for it to be online
    else if (r && "waiting" in r) out.waiting = r.waiting;
    else out.failed++;
  }
  return out;
}

/** Install the starter set into this workspace's library. Twice adds nothing twice. */
export async function installStarter(username: string) {
  const lib = await ownLibrary(username);
  if (!lib) return { error: "No Media Library here to add the sounds to", code: "not_found" as const };
  const r = await addSounds(username, lib, starter());
  return { library: lib, added: r.added.length, already: r.already, failed: r.failed, ...(r.waiting ? { waiting: r.waiting } : {}) };
}

/**
 * Take the starter set back out of the library: only the files still as they were shipped (same bytes, same title, and
 * no tag but the sound effect tag and its type). They go to the trash, as the Media Library's own removals do.
 */
export function removeStarter(lib: string): { removed: number; kept: number } {
  const byHash = new Map(starter().map((s) => [s.sha256, s]));
  const db = libraryDb();
  const rows = db
    .prepare(
      `SELECT a.id AS id, a.title AS title, v.sha256 AS sha FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
       WHERE a.library_id = ? AND a.trashed_at IS NULL AND EXISTS (SELECT 1 FROM asset_sources s WHERE s.asset_id = a.id)`,
    )
    .all(lib) as { id: string; title: string; sha: string }[];
  const out = { removed: 0, kept: 0 };
  for (const r of rows) {
    const sound = byHash.get(r.sha);
    const tags = (db.prepare("SELECT tag FROM asset_tags WHERE asset_id = ?").all(r.id) as { tag: string }[]).map((t) => t.tag);
    if (!sound || sound.title !== r.title || tags.some((t) => t !== EFFECT && !TYPE_TAGS.has(t))) {
      out.kept++;
      continue;
    }
    db.prepare("UPDATE assets SET trashed_at = ? WHERE id = ?").run(Date.now(), r.id);
    out.removed++;
  }
  return out;
}

/** The catalog sounds whose words and type match (every word must appear in the title, type or pack); starter ones first. */
export function findSounds(words: string | undefined, type: SfxType | undefined): SfxSound[] {
  const q = nameWords(words ?? "");
  return catalog()
    .sounds.filter((s) => (!type || s.type === type) && q.every((w) => `${s.title} ${s.type} ${s.pack}`.toLowerCase().includes(w)))
    .sort((a, b) => Number(b.starter) - Number(a.starter));
}

/** The assistant's tool: the first matches not yet in the library, added (at most 10). */
export async function findAndAdd(username: string, o: { words?: string; type?: SfxType; count?: number }) {
  const lib = await ownLibrary(username);
  if (!lib) return { error: "No Media Library here to add the sounds to", code: "not_found" as const };
  const n = Math.min(Math.max(Math.round(o.count ?? 5), 1), 10);
  const have = new Set(liveSounds(lib).map((s) => s.sha));
  const matches = findSounds(o.words, o.type);
  const picked = matches.filter((s) => !have.has(s.sha256)).slice(0, n);
  const r = await addSounds(username, lib, picked);
  return {
    library: lib,
    added: r.added.map((s) => ({ title: s.title, type: s.type, pack: s.pack, license: s.license, source: s.source })),
    matches: matches.length,
    failed: r.failed,
    ...(r.waiting ? { note: r.waiting } : matches.length ? {} : { note: "No sound matches those words or that type" }),
  };
}

/** Whether a workspace's libraries hold any sound effect (the editor's "From my library" default). */
export async function libraryHasSounds(username: string, workspace?: string): Promise<boolean> {
  for (const l of await librariesHere(username, workspace)) {
    if (libraryRole(username, l.id) && liveSounds(l.id).length) return true;
  }
  return false;
}

export const sfxApp = new Hono<{ Variables: AuthVars }>();

// GET /api/sfx → what Settings → Sound effects shows: the library's count, its folder, the starter set's state, the packs
sfxApp.get("/", async (c) => {
  const user = c.get("user");
  const lib = await ownLibrary(user.username);
  const live = lib ? liveSounds(lib) : [];
  const have = new Set(live.map((s) => s.sha));
  const st = starter();
  return c.json({
    library: lib,
    count: live.length,
    folder: lib ? folderOf(lib) : null,
    starter: { total: st.length, installed: st.filter((s) => have.has(s.sha256)).length },
    packs: catalog().packs,
    available: sfxDir() !== null,
  });
});

// POST /api/sfx/starter → install the starter set; DELETE → take out the ones not changed since
sfxApp.post("/starter", async (c) => {
  const r = await installStarter(c.get("user").username);
  return "error" in r ? c.json({ error: r.error, code: r.code }, 404) : c.json(r);
});
sfxApp.delete("/starter", async (c) => {
  const lib = await ownLibrary(c.get("user").username);
  if (!lib) return c.json({ error: "No Media Library here", code: "not_found" }, 404);
  return c.json(removeStarter(lib));
});

// POST /api/sfx/find {words, type, count} → the assistant's find_sound_effects
sfxApp.post("/find", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { words?: unknown; type?: unknown; count?: unknown };
  const type = typeof b.type === "string" && (SFX_TYPES as readonly string[]).includes(b.type) ? (b.type as SfxType) : undefined;
  const r = await findAndAdd(c.get("user").username, {
    words: typeof b.words === "string" ? b.words : undefined,
    type,
    count: typeof b.count === "number" ? b.count : undefined,
  });
  return "error" in r ? c.json({ error: r.error, code: r.code }, 404) : c.json(r);
});
