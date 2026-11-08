import { expect, test } from "vitest";
import { historyDepth, pageStep } from "./history-depth";

test("the arrows step over modal entries and stop where there is no page", () => {
  // home(0) → Community(1) → Workshop(2) → Settings(3), now on Workshop
  historyDepth.deepest = 3;
  historyDepth.modal = new Set([1, 3]);
  expect(pageStep(2, -1)).toBe(-2); // back to home, past Community
  expect(pageStep(2, 1)).toBe(0); // only Settings ahead: Forward off
  expect(pageStep(0, 1)).toBe(2);
  expect(pageStep(0, -1)).toBe(0);
});
