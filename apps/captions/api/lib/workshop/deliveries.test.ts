import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { inSlideOrder, storedZip } from "./deliveries";

describe("the freelancer's finals", () => {
  it("go in slide order by the number in the name, else by when they came in", () => {
    const f = (name: string, at: number) => ({ name, at });
    expect(inSlideOrder([f("10.mp4", 1), f("2.jpg", 2), f("cover.png", 0), f("slide-1.png", 3), f("notes.txt", 4)]).map((x) => x.name)).toEqual([
      "slide-1.png",
      "2.jpg",
      "10.mp4",
      "cover.png",
      "notes.txt",
    ]);
  });

  it("zip the way the iPhone app unpacks into Photos: stored, sizes and CRCs up front", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ws-zip-"));
    const files = [
      { name: "1.jpg", data: Buffer.from("first slide") },
      { name: "2.mp4", data: Buffer.alloc(70_000, 7) },
    ];
    for (const f of files) writeFileSync(path.join(dir, f.name), f.data);
    const zip = await storedZip(files.map((f) => ({ path: path.join(dir, f.name), name: f.name })));
    const chunks: Buffer[] = [];
    for await (const c of zip.body) chunks.push(c as Buffer);
    const data = Buffer.concat(chunks);
    expect(data.length).toBe(zip.size);
    // read it like StoredZip.unpack in the iPhone app WebTools.swift
    const out: Array<{ name: string; data: Buffer }> = [];
    let at = 0;
    while (at + 30 <= data.length && data.readUInt32LE(at) === 0x04034b50) {
      expect(data.readUInt16LE(at + 8)).toBe(0); // stored
      expect(data.readUInt16LE(at + 6) & 0x08).toBe(0); // no data descriptor
      const size = data.readUInt32LE(at + 18);
      const nameEnd = at + 30 + data.readUInt16LE(at + 26);
      const start = nameEnd + data.readUInt16LE(at + 28);
      const body = data.subarray(start, start + size);
      expect(data.readUInt32LE(at + 14)).toBe(crc32(body));
      out.push({ name: data.subarray(at + 30, nameEnd).toString(), data: body });
      at = start + size;
    }
    expect(out).toEqual(files);
    expect(data.readUInt32LE(data.length - 22)).toBe(0x06054b50);
  });
});
