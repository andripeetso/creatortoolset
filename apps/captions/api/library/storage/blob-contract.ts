import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { BlobStore } from "./types";

/** The checks every BlobStore passes (local.test.ts, s3.test.ts). `make` gives a fresh store and a folder for source files. */
export function blobContract(name: string, make: () => { blobs: BlobStore; dir: string }) {
  let n = 0;
  const source = (dir: string, text: string) => {
    const file = path.join(dir, `src-${n++}.bin`);
    writeFileSync(file, text);
    return file;
  };

  describe(`${name} BlobStore contract`, () => {
    it("put stores the file under its key, takes the file, and stat reports its size; a missing key is null", async () => {
      const { blobs, dir } = make();
      expect(await blobs.stat("libraries/lib_1/v/ver_1/source")).toBeNull();
      const file = source(dir, "hello world");
      expect(await blobs.put("libraries/lib_1/v/ver_1/source", file)).toEqual({ bytes: 11 });
      expect(existsSync(file)).toBe(false);
      expect(await blobs.stat("libraries/lib_1/v/ver_1/source")).toEqual({ bytes: 11 });
    });

    it("localCopy returns a path to the stored bytes, the new ones after an overwrite; for a missing key it throws", async () => {
      const { blobs, dir } = make();
      await blobs.put("libraries/lib_1/v/ver_1/thumb.jpg", source(dir, "jpeg-bytes"));
      expect(readFileSync(await blobs.localCopy("libraries/lib_1/v/ver_1/thumb.jpg"), "utf-8")).toBe("jpeg-bytes");
      await blobs.put("libraries/lib_1/v/ver_1/thumb.jpg", source(dir, "new"));
      expect(readFileSync(await blobs.localCopy("libraries/lib_1/v/ver_1/thumb.jpg"), "utf-8")).toBe("new");
      await expect(blobs.localCopy("libraries/lib_1/v/ver_1/nope")).rejects.toThrow();
    });

    it("delete removes the blob and a second delete is fine", async () => {
      const { blobs, dir } = make();
      await blobs.put("libraries/lib_1/v/ver_1/wave.json", source(dir, "[]"));
      await blobs.delete("libraries/lib_1/v/ver_1/wave.json");
      expect(await blobs.stat("libraries/lib_1/v/ver_1/wave.json")).toBeNull();
      await expect(blobs.delete("libraries/lib_1/v/ver_1/wave.json")).resolves.toBeUndefined();
      await expect(blobs.localCopy("libraries/lib_1/v/ver_1/wave.json")).rejects.toThrow();
    });

    it("refuses keys that leave the blob folder", async () => {
      const { blobs } = make();
      for (const key of ["../escape", "libraries/../../escape", "/etc/passwd", "a//b", ""]) {
        await expect(blobs.stat(key)).rejects.toThrow("Bad blob key");
      }
    });
  });
}

/**
 * An S3 client's `send` answered from memory: objects by key, multipart parts by upload id; `log` lists the commands.
 * Put it on one client (client.send = m.send) or on every client (vi.spyOn(S3Client.prototype, "send")).
 */
export function memoryS3() {
  const objects = new Map<string, Buffer>();
  const parts = new Map<string, Buffer[]>();
  const log: string[] = [];
  let uploads = 0;
  const missing = (name: string) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
  const bytesOf = async (body: unknown) => {
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === "string") return Buffer.from(body);
    const chunks: Buffer[] = [];
    for await (const c of body as Readable) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  };
  const send = async (cmd: { input: object }): Promise<unknown> => {
    const i = cmd.input as { Key: string; Body?: unknown; UploadId: string; PartNumber: number };
    log.push(cmd.constructor.name);
    if (cmd instanceof PutObjectCommand) objects.set(i.Key, await bytesOf(i.Body));
    else if (cmd instanceof HeadObjectCommand) {
      const o = objects.get(i.Key);
      if (!o) throw missing("NotFound");
      return { ContentLength: o.length };
    } else if (cmd instanceof GetObjectCommand) {
      const o = objects.get(i.Key);
      if (!o) throw missing("NoSuchKey");
      return { Body: Readable.from(o) };
    } else if (cmd instanceof DeleteObjectCommand) objects.delete(i.Key);
    else if (cmd instanceof CreateMultipartUploadCommand) {
      const id = `up${++uploads}`;
      parts.set(id, []);
      return { UploadId: id };
    } else if (cmd instanceof UploadPartCommand) {
      parts.get(i.UploadId)![i.PartNumber - 1] = await bytesOf(i.Body);
      return { ETag: `"e${i.PartNumber}"` };
    } else if (cmd instanceof CompleteMultipartUploadCommand) objects.set(i.Key, Buffer.concat(parts.get(i.UploadId)!));
    else throw new Error(`Not in the mock: ${cmd.constructor.name}`);
    return {};
  };
  return { send, objects, log };
}
