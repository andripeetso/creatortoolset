import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Transient rename errors on Windows when a concurrent reader or AV holds a handle on the file. */
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RETRY_DELAYS_MS = [20, 40, 80, 160, 320];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function renameAtomic(
  from: string,
  to: string,
  ops: { rename?: typeof rename; wait?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const mv = ops.rename ?? rename;
  const wait = ops.wait ?? sleep;
  for (let i = 0; ; i++) {
    try {
      await mv(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (!code || !RETRY_CODES.has(code) || i >= RETRY_DELAYS_MS.length) throw e;
      await wait(RETRY_DELAYS_MS[i]!);
    }
  }
}

/**
 * Temp file + rename in the same folder: a reader sees the old file or the new one, never half of one. The temp name is
 * unique, so two writes of one file at once never rename each other's half-written temp.
 */
export async function writeJsonAtomic(file: string, data: unknown, indent?: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, indent));
    await renameAtomic(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
