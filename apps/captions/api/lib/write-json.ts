import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Temp file + rename in the same folder: a reader sees the old file or the new one, never half of one. The temp name is
 * unique, so two writes of one file at once never rename each other's half-written temp.
 */
export async function writeJsonAtomic(file: string, data: unknown, indent?: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, indent));
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
