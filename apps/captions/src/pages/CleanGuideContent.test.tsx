import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import CleanGuideContent from "./CleanGuideContent";
import { CleanGuideDialog } from "./CleanGuideDialog";

it("renders the README as structured, readable content with working section targets", () => {
  const html = renderToStaticMarkup(<CleanGuideContent />);
  for (const tag of ["<table", "<ol", "<pre", "<code", "<strong", "<h2", "<h3"])
    expect(html).toContain(tag);
  expect(html).not.toContain("| --- |");
  expect(html).toContain("Reference assessment");
  expect(html).toContain("Meta outcome stays unknown.");
  const ids = new Set(
    [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]),
  );
  for (const link of html.matchAll(/href="#([^"]+)"/g))
    expect(ids.has(link[1])).toBe(true);
  expect(html).toContain('rel="noopener noreferrer"');
});
it("opens the guide with an accessible dialog trigger, without a file download", () => {
  const html = renderToStaticMarkup(<CleanGuideDialog />);
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).toContain('aria-label="Open Video Cleaner guide"');
  expect(html).not.toContain("download=");
  expect(html).not.toContain("README.md");
});
