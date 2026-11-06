import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { BlobStore } from "./types";

/** Blobs as plain files under `root` ($DATA_DIR/library/blobs in the server, see db.ts for the layout). */
export function localBlobs(root: string): BlobStore {
  // a key is slash-separated plain names: no empty, `.` or `..` part, no absolute path
  const fileOf = (key: string): string => {
    const parts = key.split("/");
    if (path.isAbsolute(key) || parts.some((p) => p === "" || p === "." || p === "..")) throw new Error(`Bad blob key: ${key}`);
    return path.join(root, ...parts);
  };
  const localCopy = async (key: string): Promise<string> => {
    const p = fileOf(key);
    await stat(p); // throws ENOENT when the blob is missing
    return p;
  };
  return {
    kind: "local",
    caps: { signedUrls: false, localPaths: true },
    async put(key, file) {
      const to = fileOf(key);
      await mkdir(path.dirname(to), { recursive: true });
      await rename(file, to); // atomic on one disk; overwrites a blob already under the key
      return { bytes: (await stat(to)).size };
    },
    async stat(key) {
      try {
        return { bytes: (await stat(fileOf(key))).size };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    delete: (key) => rm(fileOf(key), { force: true }),
    localCopy,
    async locate(key) {
      return { kind: "path", path: await localCopy(key) };
    },
  };
}
