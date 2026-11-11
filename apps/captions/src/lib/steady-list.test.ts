import { expect, it } from "vitest";
import { keptOrder } from "./steady-list";

it("a list scrolled away keeps its order: a new item waits, a moved one stays put, a deleted one goes", () => {
  const shown = ["a", "b", "c"];
  expect(keptOrder(shown, ["new", "a", "b", "c"])).toEqual(["a", "b", "c"]);
  expect(keptOrder(shown, ["c", "a", "b"])).toEqual(["a", "b", "c"]);
  expect(keptOrder(shown, ["a", "c"])).toEqual(["a", "c"]);
});
