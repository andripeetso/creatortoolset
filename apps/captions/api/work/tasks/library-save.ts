import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Sound } from "../../../contracts/library";
import type { SaveAfter } from "../../library/routes";
import { probe } from "../../library/media/probe";
import { makeThumb } from "../../library/media/thumb";
import { keepIn, quickPrint } from "../files";
import { TASK_EXPIRED, taskKind, TaskWaits, type TaskRow } from "../tasks";

/**
 * A save into a library whose Upload is none (api/library/routes.ts saveToLibrary): the file goes to the workspace's
 * Source media folder (a finished video: its Final exports folder) on one of the asker's computers, and is indexed there
 * in place. Never run on the server, its video work on or not: with no computer online it waits for one. The server holds
 * the bytes only until a computer has fetched them (`staged`), never in the library, and for WAIT_DAYS at most: then the
 * save is dropped, its bytes deleted, and the person told (in the chat whose card is about it, else the inbox).
 */

const WAIT_DAYS = 7;

export const LIBRARY_SAVE_TASK = "library-save";

export interface LibrarySaveInput {
  lib: string;
  filename: string;
  /** the server's copy until a computer has it */
  staged: string;
  /** each computer that may take it: its folder for this save (id and path there); `media`: the Media folder whose
   *  Imports/ `path` is (the import rule), which must be there before anything is written */
  folders: Record<string, { id: string; path: string; media?: string }>;
  footage: boolean;
  sound?: Sound;
  sources: string[];
  /** what runs once it is there */
  after?: SaveAfter;
}

interface Saved {
  path: string;
  folder: string;
  size: number;
  quick: string;
  duration?: number;
  width?: number;
  height?: number;
  thumb?: string;
}

taskKind<LibrarySaveInput, Saved>(LIBRARY_SAVE_TASK, {
  onComputer: true,
  ttlMs: WAIT_DAYS * 86_400_000,
  can: (d, t) => !!t.input.folders[d.id],
  serve: (t, name) => (name === "file" ? (t.input as LibrarySaveInput).staged : undefined),
  async run(input, ctx) {
    const src = await ctx.file("file");
    const folder = (await ctx.call("folder", null)) as { id: string; path: string; media?: string } | null;
    if (!folder) throw new Error("This computer has no folder for it");
    const home = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(homedir(), p.slice(1)) : p);
    // the Media folder's drive away: the save waits for it, never makes the folder on the internal disk
    if (folder.media && !existsSync(home(folder.media))) throw new TaskWaits(`Waiting for ${path.basename(folder.media)}: its drive isn't connected`);
    const dir = home(folder.path);
    const at = await keepIn(dir, input.filename, src);
    const quick = await quickPrint(at);
    if (!quick) throw new Error(`Could not read ${at}`);
    const p = await probe(at).catch(() => null);
    let thumb: string | undefined;
    if (p?.vcodec) {
      const out = path.join(ctx.dir, "thumb.jpg");
      thumb = await makeThumb(at, out, p.duration, !!p.cover, p.turn).then(() => readFile(out, "base64"), () => undefined);
    }
    return {
      result: {
        path: at,
        folder: folder.id,
        size: (await stat(at)).size,
        quick,
        ...(p?.duration ? { duration: p.duration } : {}),
        ...(p?.width && p.height ? { width: p.width, height: p.height } : {}),
        ...(thumb ? { thumb } : {}),
      },
    };
  },
  calls: {
    folder: async (t) => (t.held_by ? (t.input.folders[t.held_by] ?? null) : null),
  },
  async apply(t, r) {
    const { parseOnMac, indexOnMac } = await import("../../library/on-mac");
    const { fileSaved, soundFolder } = await import("../../library/routes");
    const { libraryDb } = await import("../../library/db");
    const device = t.held_by ?? "";
    const folder = t.input.folders[device];
    // what the computer says is checked as any index from it (a JPEG under its cap, a full path in the folder it was given)
    const x = parseOnMac({ ...r, name: t.input.filename, frames: [] });
    if (typeof x === "string") throw new Error(x);
    if (!folder || r.folder !== folder.id) throw new Error("Not the folder this save was given");
    const d = libraryDb();
    const collectionId = t.input.sound ? soundFolder(d, t.input.lib, t.input.sound, t.actor) : undefined;
    const done = await indexOnMac(t.input.lib, t.actor, { ...x, device, folder: folder.id, ...(collectionId ? { collectionId } : {}) });
    if ("versionId" in done) fileSaved(d, done.assetId, done.versionId, t.actor, t.input);
    await rm(t.input.staged, { force: true });
    const asset = "assetId" in done ? done.assetId : "duplicateOf" in done ? done.duplicateOf : null;
    const version = asset && (d.prepare("SELECT current_version_id AS v FROM assets WHERE id = ?").get(asset) as { v: string } | undefined)?.v;
    if (asset && version && t.input.after) await followUp(t.actor, t.input, asset, version);
    // a chat's card for it (use_file) ends: it is there now
    const { workEnded } = await import("../../assistant");
    workEnded(t.actor, `library-save:${t.ref}`, { status: "done", detail: "Saved", ...(asset ? { href: `/library?library=${t.input.lib}&asset=${asset}` } : {}) });
  },
  failed: (t, error) => void dropped(t, error).catch((e: unknown) => console.warn("[library-save] not told:", e instanceof Error ? e.message : e)),
});

/** What the save was for, once the file is there: its Finals piece, a sound effect's tags, the voice's edit. */
async function followUp(actor: string, input: LibrarySaveInput, assetId: string, versionId: string): Promise<void> {
  const a = input.after!;
  if ("finals" in a) {
    const { addToFinals, linkFinalsPiece } = await import("../../library/finals");
    const out = await addToFinals(a.finals, { versionId });
    if (out.ok && a.session) linkFinalsPiece(out.pieceId, a.session, undefined, a.finals.owner);
    if (out.ok && a.export) await (await import("../../exports")).finalsLanded(a.export, out.pieceId);
    if (!out.ok) console.warn(`[library-save] ${input.filename} not put in Finals: ${out.error}`);
  } else if ("sfx" in a) {
    const { libraryDb } = await import("../../library/db");
    const d = libraryDb();
    d.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag, source) VALUES (?, ?, 'ai')").run(assetId, a.sfx.type);
    d.prepare("INSERT OR IGNORE INTO asset_sources (asset_id, url, license, author, at) VALUES (?, ?, ?, ?, ?)").run(assetId, a.sfx.source, a.sfx.license, a.sfx.author, Date.now());
  } else if ("edit" in a) {
    await (await import("../../editor/voice")).editFromVoice(actor, versionId, a.edit, a.projectId);
  }
}

/** It failed for good or waited too long: its bytes go, and the person hears it was dropped, naming the file. */
async function dropped(t: TaskRow & { input: LibrarySaveInput }, error: string): Promise<void> {
  await rm(t.input.staged, { force: true });
  const say = `“${t.input.filename}” was not saved to your Media Library: ${error === TASK_EXPIRED ? `no computer of yours was online within ${WAIT_DAYS} days` : error.replace(/\.$/, "")}. Save it again when your computer is on.`;
  const { workEnded } = await import("../../assistant");
  if (workEnded(t.actor, `library-save:${t.ref}`, { status: "failed", detail: "Not saved", say })) return;
  const { notifyWorkshopOwner } = await import("../../review");
  await notifyWorkshopOwner(t.actor, { kind: "failed", by: "Media Library", name: t.input.filename, text: say, href: "/library", ref: `library-save:${t.ref}` });
}
