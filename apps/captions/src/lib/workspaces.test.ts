import { expect, it } from "vitest";
import { offAfterToggle } from "./workspaces";

it("a member's tool switch keeps the switches the dialog does not show", () => {
  // "tiny-gate" is a plug-in's gate: switching Review off, then on, must not switch the plug-in on for the member
  expect(offAfterToggle(["tiny-gate", "enhance"], "review", false)).toEqual(["tiny-gate", "enhance", "review"]);
  expect(offAfterToggle(["tiny-gate", "enhance", "review"], "review", true)).toEqual(["tiny-gate", "enhance"]);
  expect(offAfterToggle(["review"], "review", false)).toEqual(["review"]);
});
