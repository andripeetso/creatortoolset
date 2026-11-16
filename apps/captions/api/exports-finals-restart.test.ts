import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { expect, it } from "vitest";
import type { AuthVars } from "./auth";

// A restart between a finished render and the end of its send to Finals: the job on disk is done, its send is not.
const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "exports-finals-restart-"));
process.env.DATA_DIR = dataDir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const out = (n: number) => path.join(dataDir, "exports", id(n), "out.mp4");
/** A finished 1080p render as the process before left it, its send to Finals at `status`. */
const render = (n: number, status: string) => {
  mkdirSync(path.dirname(out(n)), { recursive: true });
  writeFileSync(out(n), `tiny acrobatics render ${n}`);
  const job = { id: id(n), owner: "tiny-owner", status: "done", kind: "burn", engine: "native", format: "h264", ext: "mp4", filename: `Tiny ${n}.mp4`, progress: 1, createdAt: Date.now(), finishedAt: Date.now(), finals: { status }, params: { duration: 10, width: 1080, height: 1920, finals: true, finalsLabel: `Tiny ${n}` } };
  writeFileSync(path.join(dataDir, "exports", id(n), "job.json"), JSON.stringify(job));
};
render(1, "waiting"); // cut off before anything reached the library
render(2, "sending"); // cut off after the file and its piece were in
render(3, "waiting"); // the process before this one ended the send itself, after this one read the job

const { exportsApp, resumeFinalsSends, finishedExportDirs } = await import("./exports");
const { addToFinals } = await import("./library/finals");
const { ensureLibrary } = await import("./library/access");
const { libraryDb } = await import("./library/db");

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "tiny-owner", role: "user", cloud: true, off: [] } as never);
  await next();
});
app.route("/", exportsApp);
const finalsOf = async (n: number) => ((await (await app.request(`/${id(n)}`)).json()) as { finals?: { status: string; pieceId?: string } }).finals;
const count = (sql: string, ...args: string[]) => (libraryDb().prepare(sql).get(...args) as { n: number }).n;

it("a render whose send to Finals a restart cut off is sent again once, and one that had arrived is not filed twice", async () => {
  const libraryId = (await ensureLibrary("tiny-owner", ""))!;
  const first = await addToFinals({ owner: "tiny-owner", libraryId, label: "Tiny 2", item: null, kind: "export", width: 1080, height: 1920 }, { file: out(2), filename: "Tiny 2.mp4" });
  if (!first.ok) throw new Error(first.error);
  // until it is sent again it is still on its way: Settings → Storage neither counts it nor empties it
  expect(await finishedExportDirs("tiny-owner")).toEqual([]);
  expect((await finalsOf(1))?.status).toBe("waiting");
  writeFileSync(path.join(dataDir, "exports", id(3), "job.json"), JSON.stringify({ finals: { status: "refused", error: "Not certified" } }));

  await resumeFinalsSends();

  const one = await finalsOf(1);
  expect(one).toMatchObject({ status: "sent" });
  expect(count("SELECT COUNT(*) AS n FROM piece_items WHERE piece_id = ?", one!.pieceId!)).toBe(1);
  expect(await finalsOf(2)).toEqual({ status: "sent", pieceId: first.pieceId });
  expect(count("SELECT COUNT(*) AS n FROM piece_items WHERE piece_id = ?", first.pieceId)).toBe(1);
  expect(count("SELECT COUNT(*) AS n FROM assets WHERE title LIKE 'Tiny 2%'")).toBe(1);
  expect(await finalsOf(3)).toEqual({ status: "refused", error: "Not certified" }); // taken as it ended, not sent a second time
  expect(count("SELECT COUNT(*) AS n FROM pieces")).toBe(2);
  expect(await finishedExportDirs("tiny-owner")).toHaveLength(3);
});
