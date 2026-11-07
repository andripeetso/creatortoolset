import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { keyParts, type BlobStore } from "./types";

/** Where an S3-compatible bucket is and how to sign in to it (any provider that speaks S3). */
export interface S3Place {
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  accessKey: string;
  secretKey: string;
}

export const s3Client = (p: S3Place) =>
  new S3Client({
    endpoint: p.endpoint,
    region: p.region || "us-east-1",
    forcePathStyle: p.pathStyle,
    credentials: { accessKeyId: p.accessKey, secretAccessKey: p.secretKey },
  });

const MiB = 1024 ** 2;
const notFound = (e: unknown) => {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return x?.name === "NotFound" || x?.name === "NoSuchKey" || x?.$metadata?.httpStatusCode === 404;
};

/**
 * Blobs in an S3-compatible bucket, under the same keys as on disk. `put` uploads the file and removes it (the local
 * store moves it, callers rely on the file being gone). Playback is a presigned GET. `localCopy` downloads into
 * `cacheDir` once and keeps the newest copies up to `cacheBytes`.
 */
export function s3Blobs(
  client: S3Client,
  bucket: string,
  cacheDir: string,
  opts: { cacheBytes: number; partBytes?: number },
): BlobStore {
  const partBytes = opts.partBytes ?? 64 * MiB; // a single PUT tops out at 5 GB; anything over a part goes multipart
  const cached = (key: string) => path.join(cacheDir, ...keyParts(key));

  async function multipart(key: string, file: string, size: number, contentType?: string): Promise<void> {
    const { UploadId } = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
    if (!UploadId) throw new Error("The bucket did not start the upload");
    const fh = await open(file, "r");
    try {
      const parts: { PartNumber: number; ETag?: string }[] = [];
      for (let at = 0, n = 1; at < size; at += partBytes, n++) {
        const buf = Buffer.alloc(Math.min(partBytes, size - at));
        if ((await fh.read(buf, 0, buf.length, at)).bytesRead !== buf.length) throw new Error("The file changed while it was uploading");
        const { ETag } = await client.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber: n, Body: buf }));
        parts.push({ PartNumber: n, ETag });
      }
      await client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId, MultipartUpload: { Parts: parts } }));
    } catch (e) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId })).catch(() => {});
      throw e;
    } finally {
      await fh.close();
    }
  }

  // ponytail: walks the whole cache after each download (an index if it holds many thousands of files), and may drop
  // a copy another job was handed a moment ago but has not opened yet (only once the cap is reached); a pin per job then
  async function evict(keep: string): Promise<void> {
    const files = await Promise.all(
      (await readdir(cacheDir, { recursive: true, withFileTypes: true }).catch(() => []))
        .filter((e) => e.isFile() && !e.name.startsWith(".dl-"))
        .map(async (e) => {
          const p = path.join(e.parentPath, e.name);
          const s = await stat(p).catch(() => null);
          return { p, bytes: s?.size ?? 0, used: s?.mtimeMs ?? 0 };
        }),
    );
    let total = files.reduce((n, f) => n + f.bytes, 0);
    for (const f of files.sort((a, b) => a.used - b.used)) {
      if (total <= opts.cacheBytes) break;
      if (f.p === keep) continue;
      await rm(f.p, { force: true });
      total -= f.bytes;
    }
  }

  return {
    kind: "s3",
    caps: { signedUrls: true, localPaths: false },
    async put(key, file, o) {
      keyParts(key);
      const { size } = await stat(file);
      if (size > partBytes) await multipart(key, file, size, o?.contentType);
      else {
        await client.send(
          new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(file), ContentLength: size, ContentType: o?.contentType }),
        );
      }
      await rm(cached(key), { force: true }); // an overwritten key must not serve the old bytes from the cache
      await rm(file, { force: true });
      return { bytes: size };
    },
    async stat(key) {
      keyParts(key);
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { bytes: r.ContentLength ?? 0 };
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async delete(key) {
      keyParts(key);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      await rm(cached(key), { force: true });
    },
    async localCopy(key) {
      const p = cached(key);
      const now = new Date();
      if (await utimes(p, now, now).then(() => true, () => false)) return p; // a hit counts as a use
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!r.Body) throw new Error(`Empty blob: ${key}`);
      await mkdir(path.dirname(p), { recursive: true });
      const tmp = path.join(path.dirname(p), `.dl-${process.pid}-${Date.now()}-${path.basename(p)}`);
      try {
        await pipeline(r.Body as Readable, createWriteStream(tmp));
        await rename(tmp, p);
      } finally {
        await rm(tmp, { force: true });
      }
      await evict(p);
      return p;
    },
    async locate(key, ttlSeconds, o) {
      keyParts(key);
      const cmd = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentType: o?.contentType,
        ResponseContentDisposition: o?.download ? `attachment; filename="${o.download}"` : undefined,
      });
      return { kind: "url", url: await getSignedUrl(client, cmd, { expiresIn: ttlSeconds }) };
    },
  };
}
