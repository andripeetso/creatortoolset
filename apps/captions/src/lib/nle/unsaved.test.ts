// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { fingerprint, keepUnsaved, readUnsaved } from "./unsaved";
import type { NleTimeline } from "./model";

const tl = (rec: number) => ({ timeline: { fps: 25 }, sources: {}, tracks: { V1: { items: [{ src: "a", rec, len: 10, in: 0 }] } } }) as unknown as NleTimeline;

describe("edits not saved yet", () => {
  it("come back on the same timeline, never on another one, and go once saved", () => {
    const base = fingerprint(tl(0));
    keepUnsaved("tiny/D2", base, tl(5));
    expect(readUnsaved("tiny/D2", base)?.tracks.V1.items[0].rec).toBe(5);
    expect(readUnsaved("tiny/D2", fingerprint(tl(1)))).toBeNull();
    expect(readUnsaved("tiny/D3", base)).toBeNull();
    keepUnsaved("tiny/D2", base, null);
    expect(readUnsaved("tiny/D2", base)).toBeNull();
  });
});
