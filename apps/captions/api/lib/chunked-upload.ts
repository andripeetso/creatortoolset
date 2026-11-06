import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { requestBodyStream } from "./incoming";

/**
 * Resumable chunked uploads (Video Notes, Review): the browser POSTs 16 MB
 * parts in parallel into `<dir>/<n>`, then `assembleParts` joins them.
 * `<dir>/state.json` holds what was promised at init.
 */

export const PART_SIZE = 16 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 100 * 1024 ** 3;

export const partCount = (total: number, partSize: number) =>
  Math.ceil(total / partSize);
const expectedPartSize = (total: number, partSize: number, n: number) =>
  Math.min(partSize, total - (n - 1) * partSize);

export interface UploadState {
  total: number;
  partSize: number;
  name: string;
  mime: string;
  owner: string;
}

const statePath = (dir: string) => path.join(dir, "state.json");

export async function startUpload<T extends UploadState>(
  dir: string,
  state: T,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(statePath(dir), JSON.stringify(state));
}

export async function readUploadState<T extends UploadState = UploadState>(
  dir: string,
): Promise<T | null> {
  try {
    const raw = JSON.parse(await readFile(statePath(dir), "utf-8"));
    if (
      !Number.isSafeInteger(raw?.total) ||
      !Number.isSafeInteger(raw?.partSize) ||
      typeof raw?.name !== "string" ||
      typeof raw?.mime !== "string" ||
      typeof raw?.owner !== "string"
    ) {
      return null;
    }
    return raw as T;
  } catch {
    return null;
  }
}

/** Parts already stored whole: a browser resuming an upload skips them. */
export async function receivedParts(dir: string, state: UploadState): Promise<number[]> {
  const count = partCount(state.total, state.partSize);
  const sizes = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      stat(path.join(dir, String(i + 1))).then((s) => s.size, () => -1),
    ),
  );
  return sizes.flatMap((size, i) =>
    size === expectedPartSize(state.total, state.partSize, i + 1) ? [i + 1] : [],
  );
}

export async function writeBody(c: Context, dest: string) {
  await pipeline(
    requestBodyStream(c),
    createWriteStream(dest, { highWaterMark: 1024 * 1024 }),
  );
}

/** POST <dir>/parts/:partNumber — the caller has checked the id. */
export async function receivePart(
  c: Context,
  dir: string,
  user: { username: string; role: string },
): Promise<Response> {
  const partNumber = Number(c.req.param("partNumber"));
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    return c.json({ error: "Invalid part" }, 400);
  }
  const state = await readUploadState(dir);
  if (!state) return c.json({ error: "No upload in progress" }, 409);
  if (state.owner !== user.username && user.role !== "admin") {
    return c.json({ error: "Not found" }, 404);
  }
  const total = Number(c.req.header("upload-length"));
  const partSize = Number(c.req.header("upload-part-size"));
  const contentLength = Number(c.req.header("content-length"));
  if (
    total !== state.total ||
    partSize !== state.partSize ||
    !Number.isSafeInteger(contentLength) ||
    contentLength !== expectedPartSize(state.total, state.partSize, partNumber)
  ) {
    return c.json({ error: "Invalid upload range" }, 400);
  }
  if (partNumber > partCount(state.total, state.partSize)) {
    return c.json({ error: "Invalid part" }, 400);
  }
  const finalPath = path.join(dir, String(partNumber));
  const tmpPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeBody(c, tmpPath);
    const written = (await stat(tmpPath)).size;
    if (written !== contentLength) {
      await rm(tmpPath, { force: true });
      return c.json({ error: "Part length mismatch" }, 400);
    }
    await rename(tmpPath, finalPath);
    return c.json({ ok: true, partNumber, size: written });
  } catch (e) {
    await rm(tmpPath, { force: true }).catch(() => {});
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

/** Join every part into `dest`, then remove `dir`. */
export async function assembleParts(
  dir: string,
  dest: string,
  state: UploadState,
): Promise<void> {
  const count = partCount(state.total, state.partSize);
  for (let n = 1; n <= count; n++) {
    const expected = expectedPartSize(state.total, state.partSize, n);
    const st = await stat(path.join(dir, String(n))).catch(() => null);
    if (!st || st.size !== expected) {
      throw new Error(`Part ${n} is missing or incomplete`);
    }
  }
  if (count === 1) {
    await rename(path.join(dir, "1"), dest);
  } else {
    const tmp = `${dest}.assemble-${process.pid}-${randomUUID()}`;
    const out = createWriteStream(tmp, { highWaterMark: 1024 * 1024 });
    try {
      for (let n = 1; n <= count; n++) {
        await pipeline(createReadStream(path.join(dir, String(n))), out, {
          end: false,
        });
      }
      await new Promise<void>((resolve, reject) =>
        out.end((error: Error | null | undefined) =>
          error ? reject(error) : resolve(),
        ),
      );
      if ((await stat(tmp)).size !== state.total) {
        throw new Error("Assembled size mismatch");
      }
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
