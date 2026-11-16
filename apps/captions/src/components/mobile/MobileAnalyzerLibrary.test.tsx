import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MobileAnalyzerLibrary } from "./MobileAnalyzerLibrary";

const library = (known: boolean) => renderToStaticMarkup(<MobileAnalyzerLibrary posts={[]} known={known} />);

it("shows no count and no empty line before the posts have been read once", () => {
  const html = library(false);
  expect(html).toContain("In the Content Analyzer");
  expect(html).not.toContain("In the Content Analyzer ·");
  expect(html).not.toContain("No posts");
});

it("counts the posts, and says so when there are none, once they are known", () => {
  const html = library(true);
  expect(html).toContain("In the Content Analyzer · 0");
  expect(html).toContain("No posts");
});
