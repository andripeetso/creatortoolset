import { describe, expect, it } from "vitest";
import { isPluginGateId, readiness, toolsUsing, TOOLS, TOOL_NEEDS, usesAi } from "./tools";

describe("plug-in gate ids", () => {
  it("accepts a plug-in's own id, and refuses an app id, a retired app id and a malformed id", () => {
    expect(isPluginGateId("tiny-footage")).toBe(true);
    expect(isPluginGateId("media")).toBe(false);
    expect(isPluginGateId("finals")).toBe(false);
    expect(isPluginGateId("Tiny Footage")).toBe(false);
  });
});

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

  it("on the person's own computer transcripts need no key: the Editor, Video Notes and Guide Builder are ready without one", () => {
    expect(readiness("editor", ["ai", "library", "deviceTranscripts"]).ready).toBe(true);
    expect(readiness("notes", ["ai", "deviceTranscripts"]).ready).toBe(true);
    expect(readiness("guides", ["ai", "deviceTranscripts"]).ready).toBe(true);
    expect(readiness("media", ["library", "deviceTranscripts"]).extra.map((n) => n.what)).not.toContainEqual(expect.stringMatching(/transcripts$/));
    // anywhere else the row is still missing and asks only for keys (never for "this computer")
    for (const t of ["editor", "notes", "guides"] as const) {
      const [row] = readiness(t, ["ai", "library"]).missing;
      expect(row.anyOf.every((h) => h.endsWith("_API_KEY"))).toBe(true);
      expect(row.what).toMatch(/key$/);
    }
  });

  it("every tool has a row list, and the key → tools direction matches it", () => {
    for (const t of TOOLS) expect(Array.isArray(TOOL_NEEDS[t])).toBe(true);
    expect(toolsUsing("DEEPGRAM_API_KEY")).toEqual(["captions", "media", "editor", "notes", "guides"]);
    expect(toolsUsing("apify")).toEqual(["instagram"]);
    expect(TOOLS.filter(usesAi)).toEqual(["instagram", "workshop", "captions", "media", "editor", "notes", "guides"]);
  });
});

describe("home order and need copy", () => {
  it("TOOL_GROUPS is the home's order and lists every tool once", async () => {
    const { TOOL_GROUPS } = await import("./tools");
    expect(TOOL_GROUPS.map((g) => g.label)).toEqual(["Plan", "Make", "Distribute", "Extras"]);
    expect(TOOL_GROUPS.map((g) => g.tools)).toEqual([
      ["instagram", "workshop"],
      ["media", "editor", "review"],
      [],
      ["enhance", "captions", "clean", "stories", "notes", "guides"],
    ]);
    expect(TOOL_GROUPS.flatMap((g) => g.tools).sort()).toEqual([...TOOLS].sort());
  });

  it("every need has a sentence", async () => {
    const { NEED_SENTENCE } = await import("./tools");
    const used = new Set(TOOLS.flatMap((t) => TOOL_NEEDS[t].flatMap((n) => [...n.anyOf])));
    for (const h of used) expect(NEED_SENTENCE[h as keyof typeof NEED_SENTENCE], h).toBeTruthy();
  });

  it("names every row one way: the thing to add (an optional row adds what it gives), one line for what is missing", async () => {
    const { needsLine } = await import("./tools");
    for (const t of TOOLS)
      for (const n of TOOL_NEEDS[t]) expect(n.what, `${t}: ${n.what}`).toMatch(n.optional ? /^(A|An) [^:]+: [a-zA-Z]/ : /^(A|An) [^:]+$/);
    expect(needsLine([TOOL_NEEDS.instagram[0], TOOL_NEEDS.instagram[1]])).toBe("Needs a project and an Apify key");
    expect(needsLine([TOOL_NEEDS.workshop[1]])).toBe("Needs an AI provider");
  });
});
