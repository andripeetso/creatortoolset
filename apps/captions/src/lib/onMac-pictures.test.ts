// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 11-19: photos indexed in place under Upload none came in grey: a picture the window couldn't decode (HEIC) was listed
// with no thumbnail, silently. Now the Mac makes it (importThumb), and photos already in get theirs (repairPictures).
const h = vi.hoisted(() => ({ thumb: vi.fn(), decodes: true }));
vi.mock("@/lib/thisMac", async (orig) => ({
  ...(await orig<typeof import("@/lib/thisMac")>()),
  importThumb: h.thumb,
  thisMacBridge: () => ({ postMessage: async () => ({ device: "dev_tiny" }) }),
}));
const { readIndex, repairPictures } = await import("./onMac");

class FakeImage {
  src = "";
  naturalWidth = 4032;
  naturalHeight = 3024;
  decode() {
    return h.decodes ? Promise.resolve() : Promise.reject(new Error("EncodingError"));
  }
}
beforeEach(() => {
  h.thumb.mockReset();
  h.decodes = true;
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("createImageBitmap", undefined);
  // a canvas that draws and hands back a small JPEG
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {}, fillRect() {} })) as never;
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" }));
  };
});
afterEach(() => vi.unstubAllGlobals());

describe("a photo's picture, indexed in place", () => {
  it("a JPG the window decodes gets its thumbnail here", async () => {
    const r = await readIndex(new File(["x"], "IMG_0002.JPG", { type: "image/jpeg" }), undefined, "/Volumes/Tiny/IMG_0002.JPG");
    expect(r).toMatchObject({ width: 4032, height: 3024 });
    expect(r.thumb).toBeTruthy();
    expect(h.thumb).not.toHaveBeenCalled();
  });

  it("a HEIC the window can't decode gets its picture from this Mac; with no path, none (and no error)", async () => {
    h.decodes = false;
    h.thumb.mockResolvedValue({ thumb: "/9j/4A==", width: 3024, height: 4032 });
    const heic = new File(["x"], "IMG_0001.HEIC", { type: "image/heic" });
    expect(await readIndex(heic, undefined, "/Volumes/Tiny/IMG_0001.HEIC")).toEqual({ width: 3024, height: 4032, thumb: "/9j/4A==", frames: [] });
    expect(h.thumb).toHaveBeenCalledWith("/Volumes/Tiny/IMG_0001.HEIC");
    expect(await readIndex(heic)).toEqual({ frames: [] });
  });
});

describe("repairPictures", () => {
  it("fills the library's photos with no picture from this Mac, and counts them", async () => {
    const puts: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/no-picture?device=dev_tiny"))
        return new Response(JSON.stringify({ versions: [{ versionId: "v1", path: "/Volumes/Tiny/a.HEIC" }, { versionId: "v2", path: "/Volumes/Tiny/gone.HEIC" }] }));
      if (init?.method === "PUT") puts.push(url);
      return new Response("{}");
    });
    h.thumb.mockImplementation(async (p: string) => (p.endsWith("a.HEIC") ? { thumb: "/9j/4A==", width: 1, height: 1 } : null));
    expect(await repairPictures("lib_tiny")).toBe(1);
    expect(puts).toEqual(["/api/library/lib_tiny/versions/v1/thumb"]);
  });
});
