import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-finals-"));
// set before any import that reads env.ts (the shared DATA_DIR would collide with other test files)
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";
const { libraryDb } = await import("./db");
const { addToFinals, belowHd, finalsCollectionId } = await import("./finals");
const { registerLibrarySlot, resetLibrarySlots } = await import("./sources");
const { definePlugin, mountPlugins } = await import("../lib/plugin");

afterAll(() => {
  resetLibrarySlots();
  mountPlugins(new Hono(), []);
  rmSync(dir, { recursive: true, force: true });
});

const d = () => libraryDb();
const pieceCount = (label: string) =>
  (d().prepare("SELECT COUNT(*) AS n FROM pieces WHERE label = ?").get(label) as { n: number }).n;
const itemCount = (pieceId: string) =>
  (d().prepare("SELECT COUNT(*) AS n FROM piece_items WHERE piece_id = ?").get(pieceId) as { n: number }).n;

const file = path.join(dir, "render.mp4");
writeFileSync(file, Buffer.from("tiny-acrobatics render bytes"));

beforeAll(() => {
  d().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_t', 'tiny-owner', 'Tiny', 'local', 0)").run();
  // a ready version the library already holds (a Review version, say): Finals links it
  d().prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast_1', 'lib_t', 'video', 'Roll', 'ver_1', 'tiny-owner', 0)").run();
  d().prepare(
    "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at) VALUES ('ver_1', 'ast_1', 1, 'k', 1, 'x', 'video/mp4', 'ready', 'tiny-owner', 0)",
  ).run();
});

const input = (label: string, width: number, height: number) => ({
  owner: "tiny-owner",
  libraryId: "lib_t",
  label,
  item: "V1A",
  kind: "export" as const,
  width,
  height,
});

describe("1080p floor", () => {
  it("refuses anything under 1080 on its shorter side, and names the size", () => {
    expect(belowHd(720, 1280)).toMatch(/720×1280, below 1080p/);
    expect(belowHd(1080, 1920)).toBeNull();
    expect(belowHd(1920, 1080)).toBeNull();
    expect(belowHd(undefined, undefined)).toMatch(/below 1080p/);
  });

  it("sends nothing below 1080p: no piece, no bytes", async () => {
    const out = await addToFinals(input("Tiny small", 720, 1280), { file, filename: "small.mp4" });
    expect(out).toMatchObject({ ok: false, code: "below_hd" });
    expect(pieceCount("Tiny small")).toBe(0);
  });
});

describe("addToFinals", () => {
  it("links an existing library version into a Finals piece, marks its asset, and never copies it", async () => {
    const out = await addToFinals(input("Tiny linked", 1920, 1080), { versionId: "ver_1" });
    expect(out).toMatchObject({ ok: true, assetId: "ast_1", versionId: "ver_1" });
    if (!out.ok) return;
    expect(itemCount(out.pieceId)).toBe(1);
    const marked = d().prepare("SELECT 1 FROM collection_items WHERE collection_id = ? AND asset_id = 'ast_1'").get(finalsCollectionId("lib_t"));
    expect(marked).toBeTruthy();
    expect((d().prepare("SELECT COUNT(*) AS n FROM asset_versions").get() as { n: number }).n).toBe(1);
  });

  it("stores a new vertical 1080p file once, and a second send of the same bytes links the same version", async () => {
    const first = await addToFinals(input("Tiny vertical", 1080, 1920), { file, filename: "vertical.mp4" });
    const second = await addToFinals(input("Tiny vertical", 1080, 1920), { file, filename: "vertical.mp4" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.pieceId).toBe(first.pieceId);
    expect(second.versionId).toBe(first.versionId);
    expect(itemCount(first.pieceId)).toBe(1);
  });

  it("is refused by a plug-in guard with its reason, and a guard that throws also refuses", async () => {
    mountPlugins(new Hono(), [definePlugin({ id: "tiny-guard", finals: { beforeAdd: (i) => (i.label === "Tiny held" ? "Held by Tiny guard" : null) } })]);
    const held = await addToFinals(input("Tiny held", 1920, 1080), { versionId: "ver_1" });
    expect(held).toEqual({ ok: false, code: "refused", error: "Held by Tiny guard" });
    expect(pieceCount("Tiny held")).toBe(0);
    mountPlugins(new Hono(), [definePlugin({ id: "tiny-broken", finals: { beforeAdd: () => { throw new Error("no answer"); } } })]);
    const broken = await addToFinals(input("Tiny broken", 1920, 1080), { versionId: "ver_1" });
    expect(broken).toMatchObject({ ok: false, code: "refused" });
    expect(pieceCount("Tiny broken")).toBe(0);
    mountPlugins(new Hono(), []);
  });

  it("refuses a version that is not in this library, and an account with no access", async () => {
    expect(await addToFinals(input("Tiny nope", 1920, 1080), { versionId: "ver_missing" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await addToFinals({ ...input("Tiny stranger", 1920, 1080), owner: "tiny-stranger" }, { versionId: "ver_1" })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("holds an external ref only while its source's policy allows it, with no bytes stored", async () => {
    registerLibrarySlot("tiny", { source: { id: "tiny-src", label: "Tiny source" }, policies: [{ sourceId: "tiny-src", canSee: (_v, a) => a.external?.externalId !== "hidden-1" }] });
    const ext = { source: "tiny-src", kind: "clip", externalId: "42", title: "Tiny clip" };
    const out = await addToFinals(input("Tiny external", 1920, 1080), { external: ext });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const row = d().prepare("SELECT external_ref, version_id FROM piece_items WHERE piece_id = ?").get(out.pieceId) as { external_ref: string | null; version_id: string | null };
    expect(row.external_ref).toMatch(/^ext_/);
    expect(row.version_id).toBeNull();
    const hidden = await addToFinals(input("Tiny external hidden", 1920, 1080), { external: { ...ext, externalId: "hidden-1" } });
    expect(hidden).toMatchObject({ ok: false, code: "no_access" });
    expect(pieceCount("Tiny external hidden")).toBe(0);
  });
});
