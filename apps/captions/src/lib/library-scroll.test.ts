import { describe, expect, it } from "vitest";
import { decayHeightLock, shrinkWouldClamp } from "./library-scroll";

describe("shrinkWouldClamp", () => {
  it("does not lock at the top of the page", () => {
    expect(shrinkWouldClamp(0, 900, 6000, 5000, 0)).toBe(false);
  });

  it("locks when scrolled past where the shorter page would end", () => {
    expect(shrinkWouldClamp(5000, 900, 6000, 5000, 0)).toBe(true);
  });

  it("locks once the upper page has been scrolled away", () => {
    expect(shrinkWouldClamp(800, 900, 6000, 5000, 0)).toBe(true);
  });
});

describe("decayHeightLock", () => {
  it("shrinks with the viewport as the user scrolls up", () => {
    expect(decayHeightLock(5000, -1000, 80, 900)).toBe(1900);
  });

  it("clears once the real content fills the remaining space", () => {
    expect(decayHeightLock(5000, 850, 80, 900)).toBe(0);
  });

  it("leaves a zero lock alone", () => {
    expect(decayHeightLock(0, -2000, 80, 900)).toBe(0);
  });
});
