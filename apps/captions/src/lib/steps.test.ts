import { describe, expect, it } from "vitest";
import { durationLabel } from "./workshop";

describe("a turn's time", () => {
  it("is said in minutes and seconds", () => {
    expect(durationLabel(385_000)).toBe("6 min 25 s");
    expect(durationLabel(8_400)).toBe("8 s");
  });
});
