import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CleanReferenceAssessment } from "./CleanReferenceAssessment";

it("keeps the actual ranges and uncertainty visible before measuring", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <CleanReferenceAssessment scores={{}} />
    </TooltipProvider>,
  );
  for (const text of [
    "0–31",
    "32–256",
    "0.70",
    "80%",
    "Meta outcome: unknown",
    "Measure to assess",
    "Published example",
    "no calibrated pass cutoff",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("<details");
  expect(html).not.toContain("Pass probability");
});
