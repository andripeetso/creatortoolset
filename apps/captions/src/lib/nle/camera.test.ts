import { describe, expect, it, vi } from "vitest";
import { readCamera as cameraOf, rangeReader } from "./camera";

const box = (type: string, body: Uint8Array) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};
// a Tiny Acrobatics camera file: ftyp, moov, the media data, then the maker's XML naming S-Log3
const XML = `<NonRealTimeMeta><AcquisitionRecord><Group name="CameraUnitMetadataSet"><Item name="CaptureGammaEquation" value="s-log3-cine"/><Item name="CaptureColorPrimaries" value="s-gamut3-cine"/></Group></AcquisitionRecord></NonRealTimeMeta>`;
const FILE = Buffer.concat([box("ftyp", Buffer.from("XAVC\0\0\0\0")), box("moov", Buffer.alloc(40)), box("mdat", Buffer.alloc(50_000, 7)), box("uuid", Buffer.from(XML))]);

/** A server that answers byte ranges as the Mac app's ctlocal:// does (416 past the end), or `whole`: the whole file. */
const server = (whole = false) => vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
  const m = /bytes=(\d+)-(\d+)/.exec(String((init?.headers as Record<string, string>)?.Range));
  if (whole || !m) return new Response(FILE, { status: 200 });
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a >= FILE.length ? new Response(null, { status: 416 }) : new Response(FILE.subarray(a, b + 1), { status: 206 });
}) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe("a clip's camera curve, read in the page", () => {
  it("reads what the file says with a few small ranges; on only while the Colour step is on", async () => {
    const get = server();
    expect(await cameraOf(rangeReader("ctlocal://media/a.mp4", get), async () => true)).toEqual({ curve: "slog3", from: "file", on: true });
    expect(Math.max(...get.mock.calls.map(([, i]) => { const [a, b] = String((i?.headers as Record<string, string>).Range).slice(6).split("-").map(Number); return b - a + 1; }))).toBeLessThan(1000);
    expect(await cameraOf(rangeReader("u", server()), async () => false)).toEqual({ curve: "slog3", from: "file", on: false });
    expect(await cameraOf(rangeReader("u", server()), () => Promise.reject(new Error("offline")))).toEqual({ curve: "slog3", from: "file", on: false });
  });

  it("records nothing when the server sends the whole file, the file is missing, or names no curve", async () => {
    expect(await cameraOf(rangeReader("u", server(true)), async () => true)).toBeNull();
    expect(await cameraOf(rangeReader("u", (async () => new Response(null, { status: 404 })) as typeof fetch), async () => true)).toBeNull();
    expect(await cameraOf(async () => new Uint8Array(0), async () => true)).toBeNull();
  });
});
