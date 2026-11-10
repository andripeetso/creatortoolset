import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TryStep } from "./TryStep";

const html = renderToStaticMarkup(<TryStep onStart={() => {}} />);

it("is one drop target that is also the file chooser, for video and audio", () => {
  expect(html.match(/<input/g)).toHaveLength(1);
  expect(html).toMatch(/<label[^>]*>.*<input[^>]*type="file"[^>]*accept="video\/\*,audio\/\*"/s);
  expect(html).toContain("Drop a video here");
});

it("asks for no key or password and shows nothing to paste", () => {
  expect(html).not.toMatch(/type="(password|text)"/);
  expect(html).not.toMatch(/api key|terminal|\$ /i);
});
