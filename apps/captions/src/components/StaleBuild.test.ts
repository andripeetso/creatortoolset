import { describe, expect, it } from "vitest";
import { isMissingCode } from "./StaleBuild";

describe("isMissingCode", () => {
  it("knows each browser's wording for a code file that did not load, and nothing else", () => {
    expect(isMissingCode(new TypeError("Failed to fetch dynamically imported module: https://tiny.example/assets/MediaPage-abc.js"))).toBe(true);
    expect(isMissingCode(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isMissingCode(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isMissingCode(new Error("Unable to preload CSS for /assets/x.css"))).toBe(true);
    expect(isMissingCode(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
  });
});
