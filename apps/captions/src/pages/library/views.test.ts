import { expect, it } from "vitest";
import { storedView } from "./views";

it("opens on the page's own first view before a pick, else as Appearance says", () => {
  expect(storedView("gallery")).toBe("gallery");
  expect(["folders", "list"]).toContain(storedView());
});
