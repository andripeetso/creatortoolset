import { comparisonText } from "@/lib/clean-comparison-report";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  CleanComparisonTimeline,
  CleanEditMap,
} from "./CleanComparisonTimeline";
import { CleanClipEditorDialog } from "./CleanClipEditorDialog";
import { DEFAULT_EDIT } from "@contracts/clean-edit";
import { comparisonTimeline } from "@contracts/clean-comparison";
it("shows comparison gaps as uncertainty, and exports a readable time-by-time report", () => {
  const data = comparisonTimeline(
    [{ hash: "0".repeat(64), quality: 90 }],
    [{ hash: "f".repeat(64), quality: 90 }],
    [2, 1],
    [2, 1],
  );
  const html = renderToStaticMarkup(
    <CleanComparisonTimeline measurement={{ status: "ok", ...data }} stale />,
  );
  expect(html).toContain("No sampled match");
  expect(html).toContain("Previous settings");
  expect(html).toContain("Audio is not fingerprinted");
  expect(html).not.toContain("detection-proof");
  expect(comparisonText(data)).toContain(
    "| 0.00s–1.00s | No sampled match | — | 256 |",
  );
});
it("renders the exact source map separately and opens the isolated editor with a dialog trigger", () => {
  const options = {
    ...DEFAULT_EDIT,
    adjustments: {
      ...DEFAULT_EDIT.adjustments,
      speed: 1.01,
      cuts: [
        { start: 5, end: 10 },
        { start: 0, end: 2 },
      ],
    },
  };
  const map = renderToStaticMarkup(
    <CleanEditMap adjustments={options.adjustments} duration={10} />,
  );
  expect(map).toContain("3.00s");
  expect(map).toContain("101");
  const trigger = renderToStaticMarkup(
    <CleanClipEditorDialog
      url="/video"
      name="sample.mp4"
      options={options}
      duration={10}
      onApply={() => undefined}
      onOpenChange={() => undefined}
    />,
  );
  expect(trigger).toContain('aria-haspopup="dialog"');
  expect(trigger).toContain("Edit clip");
});
