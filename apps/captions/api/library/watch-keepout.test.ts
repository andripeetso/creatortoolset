import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Amendment b: a Projects or Exports folder is never indexed by the watcher, even nested inside a watched Media folder
const dir = realpathSync(mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "watch-keepout-")));
process.env.DATA_DIR = path.join(dir, "data");
const { filesIn, keepOutOf } = await import("./watch");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const USER = "tiny";
const media = path.join(dir, "Shoots");
const projects = path.join(media, "Projects");
const exports = path.join(media, "Exports");

describe("the watcher keeps Projects and Exports folders out (Amendment b)", () => {
  mkdirSync(path.join(projects, "Tiny Edit"), { recursive: true });
  mkdirSync(exports, { recursive: true });
  mkdirSync(path.join(media, "Day 1"), { recursive: true });
  writeFileSync(path.join(media, "Day 1", "a.mp4"), "x");
  writeFileSync(path.join(projects, "Tiny Edit", "draft.mp4"), "x");
  writeFileSync(path.join(exports, "final.mp4"), "x");
  mkdirSync(path.join(dir, "data", "storage"), { recursive: true });
  const row = (id: string, role: string, p: string) => ({ id, role, name: path.basename(p), origin: { host: "this-computer", path: p }, make: true, createdAt: 0, reach: {} });
  writeFileSync(
    path.join(dir, "data", "storage", `${USER}.json`),
    JSON.stringify({ schemaVersion: 3, folders: [row("m", "footage", media), row("p", "projects", projects), row("x", "library", exports)] }),
  );

  it("lists the Projects and Exports folders of this computer as keep-out", async () => {
    expect((await keepOutOf(USER)).sort()).toEqual([exports, projects].sort());
  });

  it("a Projects folder nested inside a Media folder is not footage, and neither is an Exports folder", async () => {
    const files = await filesIn(media, await keepOutOf(USER));
    expect(files).toEqual([path.join(media, "Day 1", "a.mp4")]);
  });

  it("with no list, the same folder reads everything (the keep-out is the only thing that drops them)", async () => {
    expect((await filesIn(media)).length).toBeGreaterThan(1);
  });
});
