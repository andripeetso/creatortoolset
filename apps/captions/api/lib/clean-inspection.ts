import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  CLEANUP_LABELS,
  FULL_CLEANUP,
  type CleanupAudit,
  type CleanupPolicy,
  type DeepInspection,
  type MetadataCategory,
  type MetadataInspection,
} from "../../contracts/clean-inspection";
import { metadataItems, probe, type Probe } from "./clean-media";

// XMP UUID box; C2PA specification 2.2, appendix A.5 (BMFF embedding).
const XMP_UUID = "be7acfcb97a942e89c71999491e3afac";
const C2PA_UUID = "d8fec3d61b0e483c92975828877ec481";
const CONTAINERS = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "udta",
  "moof",
  "traf",
  "mfra",
]);
const MAX_BOXES = 30_000;
const MAX_FINDINGS = 256;
const MAX_DEPTH = 12;

export function metadataCategory(key: string): MetadataCategory {
  if (/location|gps|latitude|longitude|altitude|coordinate/i.test(key))
    return "location";
  if (
    /creation|modification|(^|[_.: -])(date|time|year|timestamp)([_.: -]|$)/i.test(
      key,
    )
  )
    return "dates";
  if (
    /artist|author|copyright|creator|producer|publisher|owner|rights|composer|performer/i.test(
      key,
    )
  )
    return "credits";
  if (
    /title|description|comment|subject|keyword|synopsis|album|genre/i.test(key)
  )
    return "description";
  if (
    /device|camera|make|model|serial|software|encoder|handler|firmware|host|computer/i.test(
      key,
    )
  )
    return "device";
  return "other";
}

async function readAt(file: FileHandle, offset: number, length: number) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, offset);
  if (bytesRead !== length) throw new Error("Truncated container header.");
  return buffer;
}

/** Walk container headers only. Never allocate or read the video's mdat payload. */
export async function inspectBmff(
  file: string,
  signal?: AbortSignal,
): Promise<DeepInspection> {
  const result: DeepInspection = {
    status: "checked",
    findings: [],
    warnings: [],
  };
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    if (size < 8) throw new Error("Container is too short to inspect.");
    const first = (await readAt(handle, 0, 8)).toString("latin1", 4, 8);
    if (
      !["ftyp", "moov", "mdat", "free", "wide", "skip", "uuid"].includes(first)
    )
      return {
        status: "unsupported",
        findings: [],
        warnings: [
          "Deep inspection supports MP4, M4V and MOV containers. Embedded metadata in this container was not checked.",
        ],
      };
    let boxes = 0;
    const walk = async (
      start: number,
      end: number,
      parent: string,
      depth: number,
    ): Promise<void> => {
      if (depth > MAX_DEPTH)
        throw new Error("Container nesting exceeded the inspection limit.");
      for (let offset = start; offset < end;) {
        signal?.throwIfAborted();
        if (++boxes > MAX_BOXES)
          throw new Error("Container exceeded the inspection limit.");
        if (end - offset < 8)
          throw new Error(
            "Trailing or truncated container bytes were not checked.",
          );
        const header = await readAt(handle, offset, 8);
        const type = header.toString("latin1", 4, 8);
        let bytes = header.readUInt32BE(0),
          headerSize = 8;
        if (bytes === 1) {
          if (end - offset < 16)
            throw new Error("Truncated extended container header.");
          const large = (await readAt(handle, offset + 8, 8)).readBigUInt64BE();
          if (large > BigInt(Number.MAX_SAFE_INTEGER))
            throw new Error("Container size exceeds safe inspection limits.");
          bytes = Number(large);
          headerSize = 16;
        } else if (bytes === 0) bytes = end - offset;
        if (bytes < headerSize || bytes > end - offset)
          throw new Error(
            "Invalid container boundary; inspection is incomplete.",
          );
        const where = `${parent}/${type}@${offset}`;
        let kind: "xmp" | "c2pa" | "unknown" | undefined;
        if (type === "uuid") {
          if (bytes < headerSize + 16)
            throw new Error("Truncated UUID metadata box.");
          const uuid = (await readAt(handle, offset + headerSize, 16)).toString(
            "hex",
          );
          kind =
            uuid === XMP_UUID ? "xmp" : uuid === C2PA_UUID ? "c2pa" : "unknown";
        } else if (type === "XMP_") kind = "xmp";
        if (kind) {
          if (result.findings.length >= MAX_FINDINGS)
            throw new Error(
              "Too many metadata boxes; inspection is incomplete.",
            );
          result.findings.push({ kind, where, bytes });
        } else if (CONTAINERS.has(type)) {
          await walk(offset + headerSize, offset + bytes, where, depth + 1);
        } else if (type === "meta") {
          if (bytes < headerSize + 4)
            throw new Error("Truncated metadata container.");
          // ISO meta is a FullBox; older QuickTime files can omit version/flags.
          const lead = (
            await readAt(handle, offset + headerSize, 4)
          ).readUInt32BE();
          await walk(
            offset + headerSize + (lead === 0 ? 4 : 0),
            offset + bytes,
            where,
            depth + 1,
          );
        }
        offset += bytes;
      }
    };
    await walk(0, size, "", 0);
  } catch (error) {
    signal?.throwIfAborted();
    result.status = "partial";
    result.warnings.push(
      error instanceof Error
        ? error.message
        : "Container inspection did not finish.",
    );
  } finally {
    await handle.close();
  }
  return result;
}
export async function inspectMetadata(
  file: string,
  signal?: AbortSignal,
  info?: Probe,
): Promise<MetadataInspection> {
  const native = metadataItems(info ?? (await probe(file, signal))).map(
    ({ where, key }) => ({
      where,
      key,
      category:
        key === "track" || key === "chapters"
          ? ("extra" as const)
          : metadataCategory(key),
    }),
  );
  return { native, embedded: await inspectBmff(file, signal) };
}
export function cleanupAudit(
  before: MetadataInspection,
  after: MetadataInspection,
  policy: CleanupPolicy = FULL_CLEANUP,
): CleanupAudit {
  const rows: CleanupAudit["rows"] = [];
  const add = (
    category: CleanupAudit["rows"][number]["category"],
    label: string,
    b: number | null,
    a: number | null,
    remove: boolean,
  ) => {
    const status =
      b === null || a === null || (category === "unknown" && (b > 0 || a > 0))
        ? "unchecked"
        : a > 0
          ? remove
            ? "remaining"
            : "kept"
          : b > 0
            ? remove
              ? "removed"
              : "not-retained"
            : "not-found";
    rows.push({ category, label, before: b, after: a, remove, status });
  };
  for (const category of Object.keys(FULL_CLEANUP) as MetadataCategory[]) {
    add(
      category,
      CLEANUP_LABELS[category],
      before.native.filter((n) => n.category === category).length,
      after.native.filter((n) => n.category === category).length,
      policy[category],
    );
  }
  add(
    "extra",
    "Chapters, cover art & extra tracks",
    before.native.filter((n) => n.category === "extra").length,
    after.native.filter((n) => n.category === "extra").length,
    true,
  );
  for (const [category, label] of [
    ["xmp", "Embedded XMP"],
    ["c2pa", "Embedded C2PA credentials"],
    ["unknown", "Unrecognized UUID boxes"],
  ] as const) {
    const count = (v: MetadataInspection) =>
      v.embedded.status === "checked"
        ? v.embedded.findings.filter((f) => f.kind === category).length
        : null;
    add(category, label, count(before), count(after), true);
  }
  return { before, after, checkedAt: Date.now(), rows };
}

/** Reapply only explicitly kept native tags from the original, never generated encoder stamps. */
export function retainedMetadataArgs(
  info: Probe,
  policy: CleanupPolicy,
  edited: boolean,
  mute: boolean,
): string[] {
  const args: string[] = [];
  const add = (
    where: string,
    tags: Record<string, string> | undefined,
    scope: string,
  ) => {
    for (const item of metadataItems({ format: { tags } })) {
      if (
        !policy[metadataCategory(item.key)] &&
        !/xmp|c2pa/i.test(item.key) &&
        !item.key.includes("=") &&
        ![...item.key].some((char) => char.charCodeAt(0) < 32)
      ) {
        const value = tags![item.key];
        // Native tag transport has a bounded size; fail explicitly rather than truncate a kept value.
        if (value.length > 64_000)
          throw new Error(
            `The kept ${where} tag ${item.key} is too large. Select removal for this category.`,
          );
        args.push(scope, `${item.key}=${value}`);
      }
    }
  };
  add("file", info.format?.tags, "-metadata");
  for (const kind of ["video", "audio"]) {
    if (kind === "audio" && mute) continue;
    const streams = (info.streams ?? []).filter(
      (s) => s.codec_type === kind && !s.disposition?.attached_pic,
    );
    (edited ? streams.slice(0, 1) : streams).forEach((s, i) =>
      add(kind, s.tags, `-metadata:s:${kind === "video" ? "v" : "a"}:${i}`),
    );
  }
  return args;
}
