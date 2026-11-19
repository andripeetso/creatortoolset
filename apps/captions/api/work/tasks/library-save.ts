import { homedir } from "node:os";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Sound } from "../../../contracts/library";
import { probe } from "../../library/media/probe";
import { makeThumb } from "../../library/media/thumb";
import { keepIn, quickPrint } from "../files";
import { taskKind } from "../tasks";

/**
 * A save into a library whose Upload is none (api/library/routes.ts saveToLibrary): the file goes to the workspace's
 * Source media folder (a finished video: its Final exports folder) on one of the asker's computers, and is indexed there
 * in place. Never run on the server, its video work on or not: with no computer online it waits for one. The server holds
 * the bytes only until a computer has fetched them (`staged`), never in the library.
 */

export const LIBRARY_SAVE_TASK = "library-save";

export interface LibrarySaveInput {
  lib: string;
  filename: string;
  /** the server's copy until a computer has it */
  staged: string;
  /** each computer that may take it: its folder for this save (id and path there) */
  folders: Record<string, { id: string; path: string }>;
  footage: boolean;
  sound?: Sound;
  sources: string[];
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
  can: (d, t) => !!t.input.folders[d.id],
  serve: (t, name) => (name === "file" ? (t.input as LibrarySaveInput).staged : undefined),
  async run(input, ctx) {
    const src = await ctx.file("file");
    const folder = (await ctx.call("folder", null)) as { id: string; path: string } | null;
    if (!folder) throw new Error("This computer has no folder for it");
    const dir = folder.path === "~" || folder.path.startsWith("~/") ? path.join(homedir(), folder.path.slice(1)) : folder.path;
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
  },
  failed: (t) => void rm(t.input.staged, { force: true }),
});
