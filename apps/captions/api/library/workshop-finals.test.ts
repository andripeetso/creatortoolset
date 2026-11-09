import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-workshop-finals-"));
// set before any import that reads env.ts (the shared DATA_DIR would collide with other test files)
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";
const { libraryDb } = await import("./db");
const { workshopFinalsFor } = await import("../workshop");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const d = () => libraryDb();

// a Workshop session on disk: its meta and one piece (doc) with a post description and one version's own text
function session(id: string, owner: string) {
  const base = path.join(dir, "workshop", "sessions", id);
  mkdirSync(path.join(base, "docs"), { recursive: true });
  writeFileSync(
    path.join(base, "meta.json"),
    JSON.stringify({ id, owner, title: "Tiny session", query: "", sources: [], drafts: [], status: "toPost" }),
  );
  writeFileSync(
    path.join(base, "docs", "doc_1.json"),
    JSON.stringify({
      id: "doc_1",
      kind: "reel",
      title: "Tiny reel",
      blocks: [{ id: "b1", text: "Tiny reel words" }],
      caption: { text: "Tiny post description", author: "ai", at: 0 },
      captions: { pci_1: { text: "Tiny version text", label: "A", author: "user", at: 0 } },
      versions: [],
    }),
  );
}

// a library with one Finals piece linked to a session, its one version a ready asset version
function linkedPiece(libraryId: string, workspace: string, pieceId: string, session: string) {
  d().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES (?, ?, 'Tiny', 'local', 0)").run(libraryId, workspace);
  d().prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, ?, 'video', 'Roll', ?, ?, 0)").run(
    `ast_${pieceId}`,
    libraryId,
    `ver_${pieceId}`,
    workspace,
  );
  d().prepare(
    "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at) VALUES (?, ?, 1, 'k', 1, 'x', 'video/mp4', 'ready', ?, 0)",
  ).run(`ver_${pieceId}`, `ast_${pieceId}`, workspace);
  d().prepare("INSERT INTO pieces (id, library_id, label, created_by, created_at, workshop_session, workshop_doc) VALUES (?, ?, 'Tiny reel', ?, 0, ?, 'doc_1')").run(
    pieceId,
    libraryId,
    workspace,
    session,
  );
  d().prepare("INSERT INTO piece_items (id, piece_id, version_id, position, winner) VALUES (?, ?, ?, 1, 1)").run(
    pieceId === "pce_own" ? "pci_1" : `pci_${pieceId}`,
    pieceId,
    `ver_${pieceId}`,
  );
}

beforeAll(() => {
  session("ses-own-1", "tiny-owner");
  session("ses-other-1", "someone-else");
  linkedPiece("lib_own", "tiny-owner", "pce_own", "ses-own-1");
  linkedPiece("lib_other", "someone-else", "pce_other", "ses-other-1");
});

describe("GET /api/library/workshop (workshopFinalsFor)", () => {
  it("returns only the owner's linked pieces, keyed by piece id, with status, description and the version's own text", async () => {
    const out = await workshopFinalsFor("tiny-owner");
    expect(Object.keys(out)).toEqual(["pce_own"]);
    expect(out.pce_own).toMatchObject({
      sessionId: "ses-own-1",
      status: "toPost",
      description: "Tiny post description",
      versions: { pci_1: { text: "Tiny version text", label: "A", author: "user" } },
    });
  });

  it("answers nothing to an account that owns no library holding the piece", async () => {
    expect(await workshopFinalsFor("someone-else-entirely")).toEqual({});
  });
});

describe("Finals pieces from a Workshop share", () => {
  it("gives the piece its share's link and its files in slide order (Save all)", async () => {
    session("5b1c0a7e-0000-4000-8000-00000000d1d1", "tiny-owner");
    linkedPiece("lib_share", "tiny-owner", "pce_share", "5b1c0a7e-0000-4000-8000-00000000d1d1");
    mkdirSync(path.join(dir, "workshop"), { recursive: true });
    writeFileSync(
      path.join(dir, "workshop", "shares.json"),
      JSON.stringify({
        tok_share: {
          owner: "tiny-owner",
          sessionId: "5b1c0a7e-0000-4000-8000-00000000d1d1",
          docIds: [],
          title: "Tiny share",
          createdAt: 0,
          progress: { state: "done", at: 0 },
          deliveries: [
            { id: "d2", name: "2 slide.jpg", size: 1, type: "image/jpeg", at: 2 },
            { id: "d1", name: "1 slide.jpg", size: 1, type: "image/jpeg", at: 1 },
          ],
          finals: { pieceId: "pce_share", sent: ["d1", "d2"], at: 3 },
        },
      }),
    );
    const pieces = await workshopFinalsFor("tiny-owner");
    expect(pieces["pce_share"]).toMatchObject({ token: "tok_share", files: [{ name: "1 slide.jpg" }, { name: "2 slide.jpg" }] });
  });
});
