import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ExtraSources } from "./ConnectorsSection";

it("shows nothing under extra things with no session source (the public build)", () => {
  expect(renderToStaticMarkup(<ExtraSources sources={[]} />)).toBe("");
});

it("shows the section with each registered session source's own words", () => {
  const html = renderToStaticMarkup(<ExtraSources sources={[{ id: "tinyacrobatics-session", label: "Tiny session reads", hint: "Set up on this server" }]} />);
  expect(html).toContain("Turn on extra things");
  expect(html).toContain("Tiny session reads");
  expect(html).toContain("Set up on this server");
});
