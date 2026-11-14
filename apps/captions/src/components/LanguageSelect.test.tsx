import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LanguageSelect } from "./LanguageSelect";

describe("LanguageSelect", () => {
  it("names the default when nothing is picked", () => {
    expect(renderToStaticMarkup(<LanguageSelect value="" onChange={() => {}} />)).toContain(">English</span>");
  });

  it("a placeholder labels the empty choice in place of the default", () => {
    const html = renderToStaticMarkup(<LanguageSelect value="" onChange={() => {}} placeholder="Other…" />);
    expect(html).toContain(">Other…</span>");
    expect(html).not.toContain(">English</span>");
  });

  it("a picked language shows its name", () => {
    expect(renderToStaticMarkup(<LanguageSelect value="et" onChange={() => {}} placeholder="Other…" />)).toContain(">Estonian</span>");
  });
});
