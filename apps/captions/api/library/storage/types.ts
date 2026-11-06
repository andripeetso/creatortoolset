/**
 * Where a library keeps its files, by key (tasks/media-library-plan.md, section 3). Keys are the same on every
 * backend, so a library moves between backends by copying keys. Local is the only backend for now.
 */
export interface BlobStore {
  readonly kind: "local" | "s3" | "bunny";
  readonly caps: { signedUrls: boolean; localPaths: boolean };
  /** Stores the file under the key. Local moves it (same disk); remote backends upload it. */
  put(key: string, file: string, opts?: { contentType?: string }): Promise<{ bytes: number }>;
  stat(key: string): Promise<{ bytes: number } | null>;
  delete(key: string): Promise<void>;
  /** A local file for ffmpeg and the editor. Local: the path itself. Remote: downloaded once into the cache. */
  localCopy(key: string): Promise<string>;
  /** Local: a path for Range streaming. Remote: a short-lived signed URL (caps.signedUrls). */
  locate(key: string, ttlSeconds: number): Promise<{ kind: "path"; path: string } | { kind: "url"; url: string }>;
}
