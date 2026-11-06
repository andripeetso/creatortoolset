import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupAudit,
  inspectBmff,
  metadataCategory,
  retainedMetadataArgs,
} from "./clean-inspection";
import {
  FULL_CLEANUP,
  type MetadataInspection,
} from "../../contracts/clean-inspection";

const dirs: string[] = [];
function box(type: string, data = Buffer.alloc(0), extended = false) {
  const header = Buffer.alloc(extended ? 16 : 8);
  header.writeUInt32BE(extended ? 1 : header.length + data.length);
  header.write(type, 4, "latin1");
  if (extended) header.writeBigUInt64BE(BigInt(header.length + data.length), 8);
  return Buffer.concat([header, data]);
}
const uuid = (id: string) => box("uuid", Buffer.from(id, "hex"));
const xmp = uuid("be7acfcb97a942e89c71999491e3afac");
const c2pa = uuid("d8fec3d61b0e483c92975828877ec481");
const ftyp = box("ftyp", Buffer.from("isom0000"));
async function fixture(data: Buffer) {
  const dir = await mkdtemp(path.join(tmpdir(), "inspect-test-"));
  dirs.push(dir);
  const file = path.join(dir, "video.mp4");
  await writeFile(file, data);
  return file;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
describe("bounded BMFF metadata inspection", () => {
  it("finds standard XMP, QuickTime XMP and C2PA at root and in metadata containers", async () => {
    const file = await fixture(
      Buffer.concat([
        ftyp,
        xmp,
        box(
          "moov",
          box(
            "udta",
            Buffer.concat([c2pa, box("XMP_", Buffer.from("packet"))]),
          ),
        ),
        box(
          "meta",
          Buffer.concat([
            Buffer.alloc(4),
            uuid("ffffffffffffffffffffffffffffffff"),
          ]),
        ),
      ]),
    );
    const result = await inspectBmff(file);
    expect(result.status).toBe("checked");
    expect(result.findings.map((f) => f.kind)).toEqual([
      "xmp",
      "c2pa",
      "xmp",
      "unknown",
    ]);
    expect(result.findings[1].where).toContain("/moov@");
  });
  it("skips a sparse multi-gigabyte media payload and finds trailing credentials", async () => {
    const file = await fixture(ftyp);
    const handle = await open(file, "r+");
    const bytes = 5 * 1024 ** 3;
    const header = box("mdat", Buffer.alloc(0), true);
    header.writeBigUInt64BE(BigInt(bytes), 8);
    try {
      await handle.write(header, 0, header.length, ftyp.length);
      await handle.write(c2pa, 0, c2pa.length, ftyp.length + bytes);
    } finally {
      await handle.close();
    }
    expect((await inspectBmff(file)).findings.map((f) => f.kind)).toEqual([
      "c2pa",
    ]);
  });
  it("does not mistake UUID bytes inside media for metadata, including size-zero boxes", async () => {
    const mdat = box("mdat", xmp);
    mdat.writeUInt32BE(0);
    expect(
      (await inspectBmff(await fixture(Buffer.concat([ftyp, mdat])))).findings,
    ).toEqual([]);
  });
  it("reports malformed, truncated and excessive-depth containers as partial", async () => {
    let nested = xmp;
    for (let i = 0; i < 15; i++) nested = box("moov", nested);
    const bad = box("uuid");
    bad.writeUInt32BE(1000);
    for (const data of [bad, Buffer.from([1, 2]), nested, box("uuid")]) {
      const result = await inspectBmff(
        await fixture(Buffer.concat([ftyp, data])),
      );
      expect(result.status).toBe("partial");
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });
  it("reports unsupported formats and cancellation explicitly", async () => {
    const file = await fixture(Buffer.from("\u001aEß£webm", "latin1"));
    expect((await inspectBmff(file)).status).toBe("unsupported");
    const controller = new AbortController();
    controller.abort();
    await expect(
      inspectBmff(await fixture(ftyp), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
describe("selective native cleanup and honest audits", () => {
  it("classifies QuickTime names without interpreting the namespace as a date", () => {
    expect(metadataCategory("com.apple.quicktime.make")).toBe("device");
    expect(metadataCategory("com.apple.quicktime.author")).toBe("credits");
    expect(metadataCategory("com.apple.quicktime.location.ISO6709")).toBe(
      "location",
    );
    expect(metadataCategory("creation_time")).toBe("dates");
    expect(metadataCategory("description")).toBe("description");
  });
  it("preserves original full-length credit values and skips embedded data and removed tracks", () => {
    const author = "Author ".repeat(60);
    const args = retainedMetadataArgs(
      {
        format: {
          tags: {
            artist: author,
            rotate: "90",
            title: "private",
            location: "private",
            xmp: "private packet",
          },
        },
        streams: [
          { index: 0, codec_type: "audio", tags: { artist: "audio author" } },
        ],
      },
      { ...FULL_CLEANUP, credits: false, other: false },
      true,
      true,
    );
    expect(args).toEqual(["-metadata", `artist=${author}`]);
  });
  it("distinguishes removed, lost retained values, and unsupported inspection without disclosing values", () => {
    const before: MetadataInspection = {
      native: [
        { category: "credits", where: "File", key: "artist" },
        { category: "location", where: "File", key: "location" },
      ],
      embedded: {
        status: "unsupported",
        findings: [],
        warnings: ["Not inspected"],
      },
    };
    const after: MetadataInspection = {
      native: [],
      embedded: { status: "checked", findings: [], warnings: [] },
    };
    const result = cleanupAudit(before, after, {
      ...FULL_CLEANUP,
      credits: false,
    });
    expect(result.rows.find((r) => r.category === "credits")?.status).toBe(
      "not-retained",
    );
    expect(result.rows.find((r) => r.category === "location")?.status).toBe(
      "removed",
    );
    expect(result.rows.find((r) => r.category === "xmp")?.status).toBe(
      "unchecked",
    );
  });
});
