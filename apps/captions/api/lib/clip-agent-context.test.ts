import { describe, expect, it } from "vitest";
import {
  buildAgentApiUrls,
  buildPublicAgentContext,
  buildRecommendedFrames,
  clipIdFromPath,
  formatAgentTimestamp,
  injectClipAgentDiscovery,
  parseTimestampMs,
  wantsAgentJson,
  wordsToAgentSegments,
} from "./clip-agent-context";

describe("clip agent discovery", () => {
  it("parses a public clip path", () => {
    expect(
      clipIdFromPath("/clips/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
    ).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(clipIdFromPath("/clips")).toBeNull();
  });

  it("prefers JSON only when it outranks HTML", () => {
    expect(wantsAgentJson("application/json")).toBe(true);
    expect(wantsAgentJson("application/agent-native+json")).toBe(true);
    expect(
      wantsAgentJson("text/html,application/xhtml+xml,application/json"),
    ).toBe(false);
    expect(wantsAgentJson("application/json,text/html")).toBe(true);
    expect(wantsAgentJson("*/*")).toBe(false);
  });

  it("injects a JSON alternate into HTML", () => {
    const html = injectClipAgentDiscovery(
      "<html><head></head><body></body></html>",
      "https://example.test",
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
    expect(html).toContain('rel="alternate"');
    expect(html).toContain("/api/agent-context.json?id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(html).toContain("agent-native.clip.discovery");
  });
});

describe("agent timestamps", () => {
  it("reads atMs or seconds", () => {
    expect(parseTimestampMs("42000")).toBe(42000);
    expect(parseTimestampMs(undefined, "12.5")).toBe(12500);
    expect(formatAgentTimestamp(90_000)).toBe("1:30");
  });

  it("builds frame URL templates", () => {
    const api = buildAgentApiUrls("rec-1", "https://app.test");
    expect(api.frameUrl(1500)).toBe(
      "https://app.test/api/agent-frame.jpg?id=rec-1&atMs=1500",
    );
    expect(api.frameUrlTemplate).toContain("atMs={timestampMs}");
  });
});

describe("transcript segments", () => {
  it("groups words into timed spans", () => {
    const segments = wordsToAgentSegments([
      { text: "Hello", start: 0, end: 0.3 },
      { text: "there", start: 0.4, end: 0.7 },
      { text: "Later", start: 12, end: 12.4 },
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe("Hello there");
    expect(segments[0].startMs).toBe(0);
    expect(segments[1].timestamp).toBe("0:12");
  });
});

describe("recommended frames", () => {
  it("starts at 0 and hits chapters", () => {
    const frames = buildRecommendedFrames({
      durationMs: 60_000,
      chapters: [{ startMs: 20_000, title: "Demo" }],
      segments: [],
    });
    expect(frames[0]?.atMs).toBe(0);
    expect(frames.some((f) => f.reason.startsWith("chapter:"))).toBe(true);
  });
});

describe("public agent context", () => {
  it("tells the agent to fetch frames", () => {
    const ctx = buildPublicAgentContext({
      origin: "https://app.test",
      clip: {
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        name: "Bug",
        duration: 40,
        status: "ready",
        summary: "A walkthrough",
        chapters: [{ t: 12, title: "The dialog" }],
        createdAt: 0,
        updatedAt: 0,
        hasThumb: true,
      },
      words: [
        { text: "Look", start: 0, end: 0.3 },
        { text: "here", start: 0.4, end: 0.7 },
      ],
    });
    expect(ctx.type).toBe("agent-native.clip.context");
    expect(ctx.apis.frame?.urlTemplate).toContain("atMs={timestampMs}");
    expect(ctx.recommendedFrames.length).toBeGreaterThan(0);
    expect(ctx.recommendedFrames[0]?.url).toContain("/api/agent-frame.jpg");
    expect(ctx.instructions.join(" ")).toMatch(/SEE the screen/i);
  });
});
