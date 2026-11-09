import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-store-"));
// set before the modules load: env.ts reads DATA_DIR once, at import
process.env.DATA_DIR = dir;

const { draftNames, editDir, readDraft, saveDraft } = await import("./store");
const { emptyTracks } = await import("./timeline");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A draft whose only mark is its name, so a test can tell revisions apart. */
const draft = (name: string): Timeline => ({ name, fps: 30, width: 1080, height: 1920, sources: {}, tracks: emptyTracks(), markers: [] });

describe("AI Editor draft revisions", () => {
  it("a saved draft that is saved again keeps the one it replaces as a revision, and the new one is the draft", async () => {
    const id = "0b1f7c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
    await saveDraft(id, "v1", { timeline: draft("first"), notes: [] });
    await saveDraft(id, "v1", { timeline: draft("second"), notes: ["B-roll: note"] });
    await saveDraft(id, "v1", { timeline: draft("third"), notes: [] });

    expect(readDraft(id, "v1")!.timeline.name).toBe("third");
    expect(readDraft(id, "v1")!.notes).toEqual([]);
    // the revisions stay on disk, one per replaced draft, and are not listed as drafts
    expect(readdirSync(path.join(editDir(id), "drafts")).sort()).toEqual(["v1.json", "v1.r1.json", "v1.r2.json"]);
    expect(JSON.parse(readFileSync(path.join(editDir(id), "drafts", "v1.r1.json"), "utf8")).timeline.name).toBe("first");
    expect(draftNames(id)).toEqual(["v1"]);
  });
});
