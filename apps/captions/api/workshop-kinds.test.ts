import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "ws-kinds-"));
const { pieceKinds } = await import("./workshop");

const doc = (kind: "reel" | "carousel" | "notes", text = "") => ({ kind, blocks: text ? [{ id: "b1", text }] : [], caption: undefined });

describe("a session's kinds in the list", () => {
  it("are the pieces with words, else every piece; notes never count", () => {
    expect(pieceKinds([doc("notes", "scraps"), doc("reel"), doc("carousel", "Slide one")])).toEqual(["carousel"]);
    expect(pieceKinds([doc("notes", "scraps"), doc("reel")])).toEqual(["reel"]);
    expect(pieceKinds([doc("reel", "a"), doc("carousel", "b"), doc("reel", "c")])).toEqual(["reel", "carousel"]);
  });
});
