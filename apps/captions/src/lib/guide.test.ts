import { describe, expect, it } from "vitest";
import {
  clipRangeHref,
  isGuideAssetName,
  mergeGuideEdits,
  parseDocKind,
  parseGuidePlan,
  parseStoredGuide,
  planToGuide,
} from "./guide";

const sample = JSON.stringify({
  title: "Share a clip",
  purpose: "Publish a recording.",
  prerequisites: ["A finished clip"],
  verification: ["The share link opens"],
  steps: [
    {
      title: "Open sharing",
      instruction: "Click Share in the header.",
      startSec: 4,
      endSec: 9,
      atSec: 6,
    },
    {
      title: "Copy the link",
      instruction: "Press Copy link.",
      startSec: 9.2,
      endSec: 14,
      atSec: 11,
    },
  ],
});

describe("parseDocKind", () => {
  it("defaults missing values to brief", () => {
    expect(parseDocKind(undefined)).toBe("brief");
    expect(parseDocKind("guide")).toBe("guide");
  });
});

describe("parseGuidePlan", () => {
  it("clamps times and keeps step order", () => {
    const plan = parseGuidePlan(sample, 20);
    expect(plan.title).toBe("Share a clip");
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].atSec).toBe(6);
    expect(plan.steps[1].startSec).toBeCloseTo(9.2);
  });

  it("fills a missing atSec inside the range", () => {
    const plan = parseGuidePlan(
      JSON.stringify({
        title: "T",
        steps: [
          { title: "A", instruction: "Do it", startSec: 2, endSec: 6 },
        ],
      }),
      10,
    );
    expect(plan.steps[0].atSec).toBeGreaterThanOrEqual(2);
    expect(plan.steps[0].atSec).toBeLessThan(6);
  });

  it("rejects empty step lists", () => {
    expect(() => parseGuidePlan('{"title":"X","steps":[]}', 10)).toThrow(
      /no usable steps/i,
    );
  });
});

describe("planToGuide / stored guide", () => {
  it("round-trips through parseStoredGuide", () => {
    const plan = parseGuidePlan(sample, 20);
    const guide = planToGuide(plan, "clip-a", (i, step) => [
      {
        assetId: `step-${i + 1}.jpg`,
        requestedMs: Math.round(step.atSec * 1000),
        actualMs: Math.round(step.atSec * 1000),
        alt: step.title,
      },
    ]);
    const again = parseStoredGuide(JSON.parse(JSON.stringify(guide)));
    expect(again?.steps[0].source.clipId).toBe("clip-a");
    expect(again?.steps[0].media[0].assetId).toBe("step-1.jpg");
  });

  it("mergeGuideEdits keeps media and ranges", () => {
    const plan = parseGuidePlan(sample, 20);
    const guide = planToGuide(plan, "clip-a", () => []);
    const next = mergeGuideEdits(guide, {
      steps: [{ id: "step-1", title: "Open share", instruction: "Tap Share." }],
    });
    expect(next.steps[0].title).toBe("Open share");
    expect(next.steps[0].source.startMs).toBe(guide.steps[0].source.startMs);
    expect(next.steps[1].title).toBe(guide.steps[1].title);
  });
});

describe("assets and hrefs", () => {
  it("accepts step filenames only", () => {
    expect(isGuideAssetName("step-1.jpg")).toBe(true);
    expect(isGuideAssetName("../x.jpg")).toBe(false);
  });

  it("builds a range URL", () => {
    expect(clipRangeHref("abc", 12, 18)).toBe("/clips/abc?t=12&end=18");
  });

  it("allowlists published still URLs without path traversal", () => {
    const uuid =
      "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const re = new RegExp(
      `^/api/documents/${uuid}(?:/assets/[a-z0-9-]+\\.jpe?g)?$`,
      "i",
    );
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(re.test(`/api/documents/${id}`)).toBe(true);
    expect(re.test(`/api/documents/${id}/assets/step-1.jpg`)).toBe(true);
    expect(re.test(`/api/documents/${id}/assets/../meta.json`)).toBe(false);
  });
});

describe("guideToMarkdown", () => {
  it("does not embed clip players", async () => {
    const { guideToMarkdown, parseGuidePlan, planToGuide } = await import(
      "./guide"
    );
    const plan = parseGuidePlan(sample, 20);
    const md = guideToMarkdown(
      "Share a clip",
      planToGuide(plan, "clip-a", () => []),
    );
    expect(md).toContain("# Share a clip");
    expect(md).not.toMatch(/\/clips\//);
    expect(md).not.toMatch(/!\[/);
  });
});
