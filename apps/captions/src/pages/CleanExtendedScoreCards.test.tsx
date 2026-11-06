import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CleanExtendedScoreCards } from "./CleanExtendedScoreCards";

describe("visible extended scores", () => {
  it("shows directional denominators, low-detail motion and stale settings without a dropdown", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <CleanExtendedScoreCards
          status="Previous settings · update needed"
          stale
          scores={{
            sscd: {
              status: "ok",
              model: "sscd_disc_mixup",
              modelSha256: "checksum",
              pairs: 4,
              meanSimilarity: 0.95,
              minSimilarity: 0.8,
            },
            visual: {
              status: "ok",
              pairs: 4,
              colorDeltaE: 15,
              contrastBefore: 10,
              contrastAfter: 15,
              brightnessBefore: 40,
              brightnessAfter: 50,
            },
            vpdq: {
              status: "ok",
              implementation: "sample",
              distanceLimit: 31,
              qualityMinimum: 50,
              before: {
                sampled: 10,
                unique: 10,
                matched: 5,
                percent: 50,
                interval: 1,
              },
              after: {
                sampled: 5,
                unique: 5,
                matched: 5,
                percent: 100,
                interval: 1,
              },
            },
            motion: {
              status: "ok",
              fps: 8,
              analysisSize: 64,
              before: { jitter: null, validTriples: 0, rejectedPairs: 9 },
              after: { jitter: 2, validTriples: 3, rejectedPairs: 0 },
            },
          }}
        />
      </TooltipProvider>,
    );
    for (const text of [
      "0.9500",
      "50.0%",
      "100.0%",
      "+5.00 pp",
      "Color difference",
      "Motion jitter",
      "Previous settings",
      "—",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("<details");
    expect(html.match(/<button /g)).toHaveLength(8);
    expect(html.match(/data-state="closed"/g)?.length).toBeGreaterThanOrEqual(
      8,
    );
  });
  it("does not present a failed metric as zero", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <CleanExtendedScoreCards
          status="Current settings"
          stale={false}
          scores={{
            sscd: {
              status: "error",
              message: "SSCD is busy. Try again shortly.",
            },
          }}
        />
      </TooltipProvider>,
    );
    expect(html).toContain("Measurement failed");
    expect(html).toContain("SSCD is busy");
    expect(html).not.toContain("0.0000");
  });
});
