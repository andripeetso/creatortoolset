import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "ws-delete-designs-"));
process.env.DATA_DIR = dataDir;
const { STORES } = await import("./lib/workspace-delete");

describe("deleting a workspace", () => {
  it("takes its designs away with their pictures, through the designs' own delete, and leaves another workspace's", async () => {
    const PROJECT = "eeeeeeee-0000-4000-8000-0000000000d1";
    const OTHER = "eeeeeeee-0000-4000-8000-0000000000d2";
    const root = path.join(dataDir, "designs", "jordan");
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    mkdirSync(path.join(root, ids[0]!), { recursive: true });
    writeFileSync(path.join(root, ids[0]!, "aaaaaaaa.png"), "x");
    writeFileSync(path.join(root, `${ids[0]}.json`), JSON.stringify({ id: ids[0], owner: "jordan", project: PROJECT, pages: [] }));
    writeFileSync(path.join(root, `${ids[1]}.json`), JSON.stringify({ id: ids[1], owner: "jordan", project: OTHER, pages: [] }));
    const store = STORES.find((s) => s.name[0] === "design")!;
    const found = await store.find({ username: "jordan" } as never, { id: "w", has: (p?: string) => p === PROJECT });
    expect(found.n).toBe(1);
    await found.drop();
    expect([existsSync(path.join(root, `${ids[0]}.json`)), existsSync(path.join(root, ids[0]!)), existsSync(path.join(root, `${ids[1]}.json`))]).toEqual([false, false, true]);
  });
});
