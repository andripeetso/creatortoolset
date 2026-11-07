import { describe, expect, it } from "vitest";
import { readiness, toolsUsing, TOOLS, TOOL_NEEDS, usesAi } from "./tools";

describe("TOOL_NEEDS readiness", () => {
  it("tools that need nothing are ready with nothing set up", () => {
    for (const t of ["review", "clean", "stories", "captions"] as const) expect(readiness(t, []).ready).toBe(true);
  });

  it("the Audio Enhancer is ready with either key", () => {
    expect(readiness("enhance", []).missing.map((n) => n.what)).toEqual(["An ElevenLabs or NVIDIA key"]);
    expect(readiness("enhance", ["NVIDIA_API_KEY"]).ready).toBe(true);
    expect(readiness("enhance", ["ELEVENLABS_API_KEY"]).ready).toBe(true);
  });

  it("the Workshop needs a project and the person's own AI: an API key alone is not enough", () => {
    expect(readiness("workshop", ["project", "ai", "ANTHROPIC_API_KEY"]).ready).toBe(false);
    const r = readiness("workshop", ["project", "ownAi"]);
    expect(r.ready).toBe(true);
    expect(r.extra.map((n) => n.anyOf)).toEqual([["PERPLEXITY_API_KEY"]]);
  });

  it("the Analyzer reads posts through the Apify key (or a login), never anything else", () => {
    expect(readiness("instagram", ["project"]).ready).toBe(false);
    expect(readiness("instagram", ["project", "apify"]).ready).toBe(true);
  });

  it("the AI Editor needs AI, a library and transcripts", () => {
    expect(readiness("editor", ["ai", "library"]).missing.map((n) => n.form)).toEqual(["keys"]);
    expect(readiness("editor", ["ai", "library", "OPENAI_API_KEY"]).ready).toBe(true);
  });

  it("every tool has a row list, and the key → tools direction matches it", () => {
    for (const t of TOOLS) expect(Array.isArray(TOOL_NEEDS[t])).toBe(true);
    expect(toolsUsing("DEEPGRAM_API_KEY")).toEqual(["captions", "media", "editor", "notes", "guides"]);
    expect(toolsUsing("apify")).toEqual(["instagram"]);
    expect(TOOLS.filter(usesAi)).toEqual(["instagram", "workshop", "captions", "media", "editor", "notes", "guides"]);
  });
});
