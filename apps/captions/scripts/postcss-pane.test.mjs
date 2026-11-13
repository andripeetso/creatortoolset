import postcss from "postcss";
import { describe, expect, it } from "vitest";
import pane from "../postcss-pane.cjs";

const run = async (css) => (await postcss([pane()]).process(css, { from: undefined })).css.replace(/\s+/g, " ").trim();
const off = (bp) => `:where(:not(html[data-pane~=lt-${bp}] :is(main, main *)))`;

describe("pane breakpoints", () => {
  it("a breakpoint's rules turn off for the page while it is narrower than it, with no added weight", async () => {
    expect(await run("@media (min-width: 1024px) { .lg\\:flex-row { flex-direction: row } }")).toBe(
      `@media (min-width: 1024px) { :is(.lg\\:flex-row)${off("lg")} { flex-direction: row } }`,
    );
  });
  it("a max-* rule stays as it was for the window and is also on for the page while it is narrower", async () => {
    expect(await run("@media not all and (min-width: 640px) { .max-sm\\:hidden { display: none } }")).toBe(
      "@media not all and (min-width: 640px) { .max-sm\\:hidden { display: none } } :is(.max-sm\\:hidden):where(html[data-pane~=lt-sm] :is(main, main *)) { display: none }",
    );
  });
  it("leaves the document's own rules, other queries and keyframes alone", async () => {
    const same = [
      "@media (min-width: 640px) { :root { --bar-h: 3.5rem } html.mac-app body { margin: 0 } }",
      "@media (min-width: 900px) { .a { color: red } }",
      "@media (hover: hover) { .a { color: red } }",
      "@media (min-width: 768px) { @keyframes spin { to { rotate: 1turn } } }",
    ];
    for (const css of same) expect(await run(css)).toBe(css);
  });
  it("a pseudo-element stays outside, an escaped colon is part of the name, and every selector of a list is scoped", async () => {
    expect(await run("@media (min-width: 768px) { .md\\:before\\:block::before, :is(.dark .b):hover, ::selection { top: 0 } }")).toBe(
      `@media (min-width: 768px) { :is(.md\\:before\\:block)${off("md")}::before, :is(:is(.dark .b):hover)${off("md")}, :is(*)${off("md")}::selection { top: 0 } }`,
    );
  });
  it("a rule inside two breakpoints needs both", async () => {
    expect(await run("@media (min-width: 768px) { @media (min-width: 1280px) { .c { top: 0 } } }")).toBe(
      `@media (min-width: 768px) { @media (min-width: 1280px) { :is(:is(.c)${off("md")})${off("xl")} { top: 0 } } }`,
    );
  });
});
