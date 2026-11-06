import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "media-store-"));
process.env.DATA_DIR = dataDir;

const { ensureProjectOriginal, projectOriginalExists } =
  await import("./media-store");

function writeMeta(
  projectId: string,
  clips: { id: string; mediaProjectId?: string; originalObjectKey?: string }[],
) {
  const dir = path.join(dataDir, "projects", projectId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id: projectId, clips }),
  );
}

function writeOriginal(projectId: string, clipId: string, bytes = "video") {
  const dir = path.join(dataDir, "projects", projectId, "clips", clipId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "original");
  writeFileSync(file, bytes);
  return file;
}

describe("shared-media originals", () => {
  it("finds the source original when exporting a copy", async () => {
    const sourceId = "source-project";
    const copyId = "copied-project";
    const clipId = "clip-aaaa-bbbb-cccc-dddd-eeeeee";
    const sourceOriginal = writeOriginal(sourceId, clipId);
    writeMeta(sourceId, [{ id: clipId }]);
    writeMeta(copyId, [{ id: clipId, mediaProjectId: sourceId }]);
    const copyPath = path.join(
      dataDir,
      "projects",
      copyId,
      "clips",
      clipId,
      "original",
    );

    expect(await projectOriginalExists(copyId, clipId, copyPath)).toBe(true);
    expect(await ensureProjectOriginal(copyId, clipId, copyPath)).toBe(
      sourceOriginal,
    );
  });
});
