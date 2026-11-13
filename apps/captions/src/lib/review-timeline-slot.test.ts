import { describe, expect, it } from "vitest";
import { reviewTimelineOf, type ReviewTimelineSlot, type WebPlugin } from "./plugin";

describe("the timeline editor's plug-in parts (reviewTimelineOf)", () => {
  it("hands the panel each part from the first plug-in that gives it, Make the next version among them", () => {
    const first: ReviewTimelineSlot = { camera: async () => "a", next: async () => {} };
    const second: ReviewTimelineSlot = { camera: async () => "b", clipSrc: () => "c", sources: async () => ({}) };
    const got = reviewTimelineOf([{ id: "one", review: { timeline: first } }, { id: "two", review: { timeline: second } }, { id: "none" }] as unknown as WebPlugin[]);
    expect(got.camera).toBe(first.camera);
    expect(got.next).toBe(first.next);
    expect(got.clipSrc).toBe(second.clipSrc);
    expect(got.sources).toBe(second.sources);
    expect([got.look, got.face]).toEqual([undefined, undefined]);
    expect(reviewTimelineOf([]).next).toBeUndefined();
  });
});
