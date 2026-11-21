import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A hidden <video> stand-in: loads when given a file, seeks when told, and counts as open while it holds one.
const made: FakeVideo[] = [];
class FakeVideo extends EventTarget {
  error = null;
  duration = 100;
  videoWidth = 16;
  private file = "";
  get src() {
    return this.file;
  }
  set src(v: string) {
    this.file = v;
    if (v) setTimeout(() => this.dispatchEvent(new Event("loadeddata")));
  }
  set currentTime(_: number) {
    setTimeout(() => this.dispatchEvent(new Event("seeked")));
  }
  removeAttribute(name: string) {
    if (name === "src") this.file = "";
  }
  load() {}
}
const openNow = () => made.filter((v) => v.src).length;

const was = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap };
let most = 0;
beforeAll(() => {
  Object.assign(globalThis, {
    document: { createElement: () => (made.push(new FakeVideo()), made.at(-1)) },
    createImageBitmap: async () => ((most = Math.max(most, openNow())), { width: 16, height: 9 }),
  });
});
afterAll(() => void Object.assign(globalThis, was));

describe("timeline thumbnails", () => {
  it("keeps one file open at a time and lets it go once nothing is left to draw", async () => {
    const { thumbAt } = await import("./thumbs");
    // a timeline of several camera files: each one's clips ask for their pictures
    const got = await Promise.all(["a", "b", "c", "d"].flatMap((f) => [0, 1, 2].map((s) => thumbAt(`/m/${f}.mp4`, s))));
    expect(got.every(Boolean)).toBe(true);
    expect(made).toHaveLength(4);
    expect(most).toBe(1);
    expect(openNow()).toBe(0);
    // asked again later: opened again, and let go again
    await thumbAt("/m/a.mp4", 5);
    expect(openNow()).toBe(0);
  });
});
