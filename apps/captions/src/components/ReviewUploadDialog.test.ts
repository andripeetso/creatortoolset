import { describe, expect, it } from "vitest";
import { pairFiles } from "./ReviewUploadDialog";

const f = (name: string) => new File(["x"], name);
const names = (r: ReturnType<typeof pairFiles>) => ({
  items: r.items.map((x) => `${x.video.name}+${x.timeline?.name ?? ""}`),
  lone: r.lone.map((t) => t.name),
});

describe("pairFiles", () => {
  it("pairs a timeline with the video named like it, else the only video without one", () => {
    expect(names(pairFiles([f("A.mov"), f("B.mov"), f("b.otio"), f("other.edl")]))).toEqual({
      items: ["A.mov+", "B.mov+b.otio"],
      lone: ["other.edl"],
    });
    expect(names(pairFiles([f("Cut v3.mp4"), f("Timeline 1.xml")]))).toEqual({ items: ["Cut v3.mp4+Timeline 1.xml"], lone: [] });
  });

  it("adds to what's already picked, never replacing a video's timeline", () => {
    const first = pairFiles([f("A.mov"), f("A.otio")]);
    expect(names(pairFiles([f("B.mov"), f("x.fcpxml")], first.items))).toEqual({
      items: ["A.mov+A.otio", "B.mov+x.fcpxml"],
      lone: [],
    });
  });
});
