import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";

export interface Delivery {
  id: string;
  name: string;
  size: number;
  type: string;
  by?: string;
  note?: string;
  at: number;
}

/** The finals in slide order: the number in the name ("3.jpg", "slide-3.png"), else when it came in. */
export function inSlideOrder<T extends Pick<Delivery, "name" | "at">>(files: T[]): T[] {
  const n = (f: T) => Number(/\d+/.exec(f.name)?.[0] ?? Infinity);
  return [...files].sort((a, b) => n(a) - n(b) || a.at - b.at);
}

async function fileCrc(file: string): Promise<number> {
  let crc = 0;
  for await (const chunk of createReadStream(file)) crc = crc32(chunk as Buffer, crc);
  return crc;
}

/**
 * The files as one ZIP, stored (not compressed) with sizes and CRCs up front:
 * what the iPhone app unpacks into Photos (`StoredZip` in the iPhone app WebTools.swift),
 * like Story Splitter's. Each file is read twice (CRC first, then the bytes).
 */
export async function storedZip(files: Array<{ path: string; name: string }>, now = new Date()): Promise<{ body: Readable; size: number }> {
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const entries: Array<{ path: string; name: Buffer; size: number; crc: number; offset: number }> = [];
  let offset = 0;
  for (const f of files) {
    const size = (await stat(f.path)).size;
    const name = Buffer.from(f.name);
    entries.push({ path: f.path, name, size, crc: await fileCrc(f.path), offset });
    offset += 30 + name.length + size;
  }
  if (offset > 0xffffffff) throw new Error("Over 4 GB: download the files one by one.");
  const local = (e: (typeof entries)[number]) => {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(e.crc, 14);
    h.writeUInt32LE(e.size, 18);
    h.writeUInt32LE(e.size, 22);
    h.writeUInt16LE(e.name.length, 26);
    return Buffer.concat([h, e.name]);
  };
  const central = Buffer.concat(
    entries.map((e) => {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(time, 12);
      h.writeUInt16LE(date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.size, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt32LE(e.offset, 42);
      return Buffer.concat([h, e.name]);
    }),
  );
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  async function* parts() {
    for (const e of entries) {
      yield local(e);
      yield* createReadStream(e.path);
    }
    yield central;
    yield end;
  }
  return { body: Readable.from(parts()), size: offset + central.length + end.length };
}
