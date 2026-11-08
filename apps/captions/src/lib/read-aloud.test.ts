import { describe, expect, it } from "vitest";
import { spoken } from "./read-aloud";

describe("spoken", () => {
  it("reads a reply's words, not its marks", () => {
    expect(spoken("Open [the first one](https://example.com/r/1) and **check the hook**.")).toBe("Open the first one and check the hook.");
    expect(spoken("Here:\n```\nnpm run dev\n```\nDone")).toBe("Here:\n \nDone");
    expect(spoken("- one\n- two")).toBe("one\ntwo");
    expect(spoken("See https://example.com now")).toBe("See now");
  });
});
