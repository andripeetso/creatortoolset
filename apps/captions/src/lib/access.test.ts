import { describe, expect, it } from "vitest";
import { fromUserAgent } from "./access";

// What a sign-in's row shows when it has no name of its own: read from the browser's own words, for the list alone.
describe("fromUserAgent", () => {
  it("names the browser, its system and the kind of thing it runs on", () => {
    expect(fromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15")).toEqual({ name: "Safari", os: "macOS", kind: "desktop" });
    expect(fromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")).toEqual({ name: "Chrome", os: "Windows", kind: "desktop" });
    expect(fromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0")).toMatchObject({ name: "Edge" });
    expect(fromUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toEqual({ name: "Firefox", os: "Linux", kind: "desktop" });
    expect(fromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1")).toEqual({ name: "Safari", os: "iOS", kind: "mobile" });
    expect(fromUserAgent("Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1")).toMatchObject({ os: "iPadOS", kind: "tablet" });
  });

  it("calls the app's own window and its own requests Creator Toolset", () => {
    // a web view: AppleWebKit with no browser's name
    expect(fromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toEqual({ name: "Creator Toolset", os: "macOS", kind: "desktop" });
    expect(fromUserAgent("Creator%20Toolset/3760 CFNetwork/3860.700.1 Darwin/25.6.0")).toMatchObject({ name: "Creator Toolset" });
  });

  it("says nothing of a sign-in that sent no User-Agent", () => {
    expect(fromUserAgent(undefined)).toBeNull();
    expect(fromUserAgent("")).toBeNull();
  });
});
