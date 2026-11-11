import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { ReplyText } from "./ReplyText";

const text = "Open [Tiny tumbles](/editor/e1/V1A_D1) or read [the guide](https://example.com/guide).";

it("a link to a page of this app opens here, and a link to another site opens in a new tab", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ReplyText text={text} />
    </MemoryRouter>,
  );
  expect(html).toMatch(/<a href="\/editor\/e1\/V1A_D1" class="[^"]*">Tiny tumbles<\/a>/);
  expect(html).toMatch(/<a href="https:\/\/example.com\/guide" target="_blank" rel="noreferrer"/);
});

it("with no router around it (a share page), every link opens in a new tab as before", () => {
  expect(renderToStaticMarkup(<ReplyText text={text} />)).toMatch(/<a href="\/editor\/e1\/V1A_D1" target="_blank"/);
});
