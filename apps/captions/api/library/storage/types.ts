/**
 * Where a library keeps its files, by key (tasks/media-library-plan.md, section 3). Keys are the same on every
 * backend, so a library moves between backends by copying keys. Backends: local.ts (default) and s3.ts.
 */
export interface BlobStore {
  readonly kind: "local" | "s3";
  readonly caps: { signedUrls: boolean; localPaths: boolean };
  /** Stores the file under the key and takes it: local moves it (same disk), s3 uploads it and removes it. */
  put(key: string, file: string, opts?: { contentType?: string }): Promise<{ bytes: number }>;
  stat(key: string): Promise<{ bytes: number } | null>;
  delete(key: string): Promise<void>;
  /** A local file for ffmpeg and the editor. Local: the path itself. Remote: downloaded once into the cache. */
  localCopy(key: string): Promise<string>;
  /** Local: a path for Range streaming. Remote: a short-lived signed URL (caps.signedUrls) answering with this type or as a download. */
  locate(
    key: string,
    ttlSeconds: number,
    opts?: { contentType?: string; download?: string },
  ): Promise<{ kind: "path"; path: string } | { kind: "url"; url: string }>;
}

/** A key's parts: slash-separated plain names, no empty, `.` or `..` part, no absolute path. Throws on any other key. */
export function keyParts(key: string): string[] {
  const parts = key.split("/");
  if (key.startsWith("/") || key.includes("\\") || parts.some((p) => p === "" || p === "." || p === "..")) throw new Error(`Bad blob key: ${key}`);
  return parts;
}
