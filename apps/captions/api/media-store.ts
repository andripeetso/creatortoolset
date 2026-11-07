import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, link, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { env } from "./lib/env";
import { versionSource } from "./library/access";
import {
  mediaOwnerProjectId,
  originalProjectIds,
  sharedOriginalObjectKey,
} from "./lib/project-copy";

const configured = Boolean(
  env.objectStorageEndpoint &&
  env.objectStorageBucket &&
  env.objectStorageAccessKey &&
  env.objectStorageSecretKey,
);

const client = configured
  ? new S3Client({
      endpoint: env.objectStorageEndpoint,
      region: env.objectStorageRegion || "us-east-1",
      forcePathStyle: env.objectStorageForcePathStyle,
      credentials: {
        accessKeyId: env.objectStorageAccessKey,
        secretAccessKey: env.objectStorageSecretKey,
      },
    })
  : null;

const bucket = env.objectStorageBucket;

export const objectStorageEnabled = () => !!client;

export const sourceObjectKey = (projectId: string, clipId: string) =>
  `projects/${projectId}/clips/${clipId}/original`;

function requireClient(): S3Client {
  if (!client) throw new Error("Object storage is not configured");
  return client;
}

export interface StoredMultipartPart {
  partNumber: number;
  etag: string;
  size: number;
}

export async function createSourceMultipart(
  key: string,
  contentType: string,
): Promise<string> {
  const response = await requireClient().send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType || "application/octet-stream",
    }),
  );
  if (!response.UploadId)
    throw new Error("Object store did not return an upload id");
  return response.UploadId;
}

export async function abortSourceMultipart(
  key: string,
  uploadId: string,
): Promise<void> {
  await requireClient().send(
    new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
    }),
  );
}

export async function listSourceParts(
  key: string,
  uploadId: string,
): Promise<StoredMultipartPart[]> {
  const result: StoredMultipartPart[] = [];
  let marker: string | undefined;
  do {
    const response = await requireClient().send(
      new ListPartsCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: marker,
      }),
    );
    for (const part of response.Parts ?? []) {
      if (part.PartNumber && part.ETag) {
        result.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          size: part.Size ?? 0,
        });
      }
    }
    marker = response.IsTruncated ? response.NextPartNumberMarker : undefined;
  } while (marker);
  return result;
}

export async function presignSourcePart(
  key: string,
  uploadId: string,
  partNumber: number,
): Promise<string> {
  return getSignedUrl(
    requireClient(),
    new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn: 15 * 60 },
  );
}

export async function completeSourceMultipart(
  key: string,
  uploadId: string,
  parts: StoredMultipartPart[],
): Promise<string> {
  const response = await requireClient().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((part) => ({ ETag: part.etag, PartNumber: part.partNumber })),
      },
    }),
  );
  return response.ETag ?? "";
}

export async function deleteStoredSource(key: string): Promise<void> {
  if (!client) return;
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function downloadStoredSource(
  key: string,
  destination: string,
): Promise<void> {
  if (existsSync(destination)) return;
  await mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.object-download-${process.pid}`;
  await rm(temp, { force: true }).catch(() => {});
  try {
    const response = await requireClient().send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!response.Body)
      throw new Error("Object store returned an empty source");
    await pipeline(
      response.Body as NodeJS.ReadableStream,
      createWriteStream(temp),
    );
    await rename(temp, destination);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

type ClipMedia = {
  id?: string;
  originalObjectKey?: string;
  mediaProjectId?: string;
  /** The clip came from the Media Library: its original is that version's source (api/library/access.ts). */
  libraryVersionId?: string;
};

function clipOriginalFile(projectId: string, clipId: string): string {
  return path.join(
    env.dataDir,
    "projects",
    projectId,
    "clips",
    clipId,
    "original",
  );
}

export async function readProjectClip(
  projectId: string,
  clipId: string,
): Promise<(ClipMedia & { owner?: string }) | null> {
  try {
    const meta = JSON.parse(
      await readFile(
        path.join(env.dataDir, "projects", projectId, "meta.json"),
        "utf-8",
      ),
    ) as { owner?: string; clips?: ClipMedia[] };
    const clip = meta.clips?.find((c) => c.id === clipId);
    return clip ? { ...clip, owner: meta.owner } : null;
  } catch {
    return null;
  }
}

async function resolveSharedOriginal(
  projectId: string,
  clipId: string,
  destination: string,
): Promise<{
  localPaths: string[];
  objectKey: string | null;
  cachePath: string;
  /** the library version the clip came from, read as the project's owner */
  library: { versionId: string; owner: string } | null;
}> {
  const clip = await readProjectClip(projectId, clipId);
  const home = mediaOwnerProjectId(projectId, clip);
  const cachePath = clipOriginalFile(home, clipId);
  const localPaths = [
    destination,
    ...originalProjectIds(projectId, clip).map((id) =>
      clipOriginalFile(id, clipId),
    ),
  ];
  let objectKey = sharedOriginalObjectKey(clip);
  if (!objectKey && home !== projectId) {
    objectKey = sharedOriginalObjectKey(await readProjectClip(home, clipId));
  }
  const library =
    clip?.libraryVersionId && clip.owner
      ? { versionId: clip.libraryVersionId, owner: clip.owner }
      : null;
  return { localPaths, objectKey, cachePath, library };
}

/**
 * Render workers use the legacy local path as a cache. New projects resolve
 * the object key from meta.json and download it lazily; old projects continue
 * to work without a migration or outage. Admin copies share media, so this
 * also follows mediaProjectId instead of requiring a second original.
 */
export async function ensureProjectOriginal(
  projectId: string,
  clipId: string,
  destination: string,
): Promise<string | null> {
  const { localPaths, objectKey, cachePath, library } =
    await resolveSharedOriginal(projectId, clipId, destination);
  for (const localPath of localPaths) {
    if (existsSync(localPath)) return localPath;
  }
  if (objectKey) {
    try {
      await downloadStoredSource(objectKey, cachePath);
      return cachePath;
    } catch {
      if (!library) return null;
    }
  }
  if (!library) return null;
  // the library's file under the clip's name again: a hard link (no extra disk), a copy across disks
  const source = await versionSource(library.owner, library.versionId);
  if (!source) return null;
  await mkdir(path.dirname(cachePath), { recursive: true });
  await rm(cachePath, { force: true });
  await link(source, cachePath).catch(() => copyFile(source, cachePath));
  return cachePath;
}

export async function projectOriginalExists(
  projectId: string,
  clipId: string,
  legacyPath: string,
): Promise<boolean> {
  const { localPaths, objectKey, library } = await resolveSharedOriginal(
    projectId,
    clipId,
    legacyPath,
  );
  return (
    localPaths.some((localPath) => existsSync(localPath)) ||
    !!objectKey ||
    (!!library && (await versionSource(library.owner, library.versionId)) !== null)
  );
}
