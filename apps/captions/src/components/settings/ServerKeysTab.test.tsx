import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ServerKeysTab } from "./ServerKeysTab";

it("is not drawn on an own-computer install (the .env is the only place there)", () => {
  expect(renderToStaticMarkup(<ServerKeysTab />)).toBe("");
});
