import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { linkParts, ReplyText } from "./ReplyText";

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

it("a file this server hands out (a finished export) is saved when pressed: it is not a page to move to", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ReplyText text={"It is ready: [Download it](/api/exports/e1/file)."} />
    </MemoryRouter>,
  );
  expect(html).toMatch(/<a href="\/api\/exports\/e1\/file" download="" class="[^"]*">Download it<\/a>/);
});

it("with no router around it (a share page), every link opens in a new tab as before", () => {
  expect(renderToStaticMarkup(<ReplyText text={text} />)).toMatch(/<a href="\/editor\/e1\/V1A_D1" target="_blank"/);
});

it("a picture from another site is not loaded: it shows as a link, and one of this app's own is shown", () => {
  const html = renderToStaticMarkup(<ReplyText text={"Here ![the chart](https://example.com/p.png?q=secret) and ![a still](/api/review/r1/thumb) and ![](//example.com/x.png)"} />);
  expect(html).not.toMatch(/<img[^>]+src="(https?:)?\/\/example\.com/);
  expect(html).not.toMatch(/<link[^>]+example\.com/); // no preload of it either
  expect(html).toMatch(/<a href="https:\/\/example.com\/p.png\?q=secret" target="_blank" rel="noreferrer"[^>]*>the chart<\/a>/);
  expect(html).toMatch(/<img src="\/api\/review\/r1\/thumb" alt="a still"/);
});

it("a code block wraps its long lines and has a Copy button", () => {
  const html = renderToStaticMarkup(<ReplyText text={"```\nYou write as Tiny Acrobatics, in first person.\n```"} />);
  expect(html).toMatch(/<pre class="[^"]*whitespace-pre-wrap[^"]*">/);
  expect(html).toContain('aria-label="Copy"');
});

it("finds the addresses in plain text, without the full stop or bracket after them", () => {
  expect(linkParts("use this https://www.youtube.com/watch?v=zsCD5XCu6CM this song")).toEqual([
    { text: "use this " },
    { text: "https://www.youtube.com/watch?v=zsCD5XCu6CM", href: "https://www.youtube.com/watch?v=zsCD5XCu6CM" },
    { text: " this song" },
  ]);
  expect(linkParts("(see https://example.com/a.)").map((p) => p.href).filter(Boolean)).toEqual(["https://example.com/a"]);
  expect(linkParts("no link here")).toEqual([{ text: "no link here" }]);
});
