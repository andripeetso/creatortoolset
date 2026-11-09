import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LibraryFacetBar } from "./LibraryFacetBar";

const safety = {
  key: "safety",
  label: "Safety",
  values: [
    { value: "checked", label: "Checked" },
    { value: "open", label: "Open" },
  ],
};

describe("LibraryFacetBar", () => {
  it("renders a plug-in facet with its values, and marks the picked ones", () => {
    const html = renderToStaticMarkup(<LibraryFacetBar facets={[safety]} value={{ safety: ["open"] }} onChange={() => {}} />);
    expect(html).toContain('aria-label="Safety"');
    expect(html).toContain("Checked");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Open</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Checked</);
  });

  it("renders nothing with no plug-in facet, so the default view is unchanged", () => {
    expect(renderToStaticMarkup(<LibraryFacetBar facets={[]} value={{}} onChange={() => {}} />)).toBe("");
  });
});
