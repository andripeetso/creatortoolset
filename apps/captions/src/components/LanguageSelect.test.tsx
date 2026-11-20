import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LanguageSelect, toggleLanguage } from "./LanguageSelect";

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

  it("several picked languages are all named", () => {
    expect(renderToStaticMarkup(<LanguageSelect values={["et", "en"]} onValuesChange={() => {}} />)).toContain(">Estonian, English</span>");
  });

  it("several: the default language can be ticked alongside another, and unticking the last goes back to the default", () => {
    expect(toggleLanguage([], ["en"], "et")).toEqual(["en", "et"]);
    expect(toggleLanguage(["et"], ["en"], "en")).toEqual(["et", "en"]);
    expect(toggleLanguage(["et", "en"], ["en"], "et")).toEqual(["en"]);
    expect(toggleLanguage(["et"], ["en"], "et")).toEqual([]);
    expect(toggleLanguage([], ["en"], "en")).toEqual([]);
  });
});
