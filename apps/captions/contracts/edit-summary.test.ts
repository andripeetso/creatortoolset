import { describe, expect, it } from "vitest";
import { describeChanges, describeEdits, type SummaryTimeline } from "./edit-summary";

const tl = (tracks: SummaryTimeline["tracks"]): SummaryTimeline => ({
  timeline: { fps: 25 },
  tracks,
  sources: { a: { path: "/footage/Tiny Acrobatics/IMG_0001.MOV" }, b: { path: "/footage/logo.png" } },
});
const shot = (rec: number, at: number, len = 50) => ({ src: "a", rec, in: at, len });

describe("describeChanges", () => {
  it("says nothing for the same timeline", () => {
    const t = tl({ V1: { items: [shot(0, 0), shot(50, 100)] } });
    expect(describeChanges(t, structuredClone(t))).toBe("");
  });

  it("names trims, moves, removals, additions and sound by track and file", () => {
    const before = tl({
      V1: { items: [shot(0, 0), shot(50, 100), shot(100, 200), shot(150, 300), shot(200, 400)] },
      V2: { items: [{ src: "b", rec: 25, in: 0, len: 25 }] },
      A2: { items: [{ src: "a", rec: 0, in: 900, len: 100 }] },
    });
    const after = tl({
      // the second shot ends 1 s sooner and everything after it moves up a second
      V1: { items: [shot(0, 0), shot(50, 100, 25), shot(75, 200), shot(125, 300), shot(175, 400)] },
      V2: { items: [{ src: "b", rec: 150, in: 0, len: 25 }] },
      A2: { items: [{ src: "a", rec: 0, in: 900, len: 100, gain_db: -6 }] },
      V3: { items: [{ src: "c", rec: 0, in: 0, len: 25 }] },
    });
    expect(describeChanges(before, after)).toBe(
      "3 clips 1.00 s earlier; A2 IMG_0001: sound 0 → -6 dB; V1 IMG_0001: 1.00 s off the end; V2 logo: moved to 0:06.0; V3 c: added at 0:00.0",
    );
    expect(describeChanges(after, before)).toContain("V3 c: removed (was at 0:00.0)");
  });

  it("matches a clip by the editor's handle, and calls a split's second part a piece of it", () => {
    const before = tl({ V1: { items: [{ ...shot(0, 0, 100), _k: "c1" }] } });
    const after = tl({ V1: { items: [{ ...shot(0, 0), _k: "c1" }, { ...shot(50, 50), _k: "c2" }] } });
    expect(describeChanges(before, after)).toBe("V1 IMG_0001: 2.00 s off the end; V1 IMG_0001: another piece of it at 0:02.0 (split or copied)");
  });
});

describe("describeEdits", () => {
  it("says each clip's edit with its track, and stops at its length", () => {
    expect(describeEdits([{ key: "V1:30", label: "Second line", remove: true }, { key: "V2:0", label: "Logo", move: 50 }], 25))
      .toBe("Second line on V1: taken out with its voice, what follows moves up; Logo on V2: 2.00 s later");
    const many = Array.from({ length: 40 }, (_, i) => ({ key: `V2:${i}`, label: `Clip ${i}`, move: 50 }));
    const said = describeEdits(many, 25);
    expect(said.length).toBeLessThan(640);
    expect(said).toMatch(/; and \d+ more$/);
  });
});
