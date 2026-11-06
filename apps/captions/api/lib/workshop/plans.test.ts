import { describe, expect, it } from "vitest";
import { PLAN_PARSERS, jsonObject, parseAdPlan, parseCarouselPlan, parseFreePlan, parseReelPlan } from "./plans";

describe("jsonObject", () => {
  it("strips fences, prose, and one JSON-mode wrap", () => {
    expect(jsonObject('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(jsonObject('{"json":"{\\"a\\":2}"}')).toEqual({ a: 2 });
    expect(jsonObject('{"plan":{"a":3}}')).toEqual({ a: 3 });
    expect(() => jsonObject("no json here")).toThrow(/JSON/);
  });
});

describe("plan parsers", () => {
  it("parses a reel plan and clamps lists", () => {
    const plan = parseReelPlan(
      JSON.stringify({
        title: "T",
        hook: { spoken: "Stop scrolling", onScreen: "STOP" },
        beats: Array.from({ length: 12 }, (_, i) => ({ label: `b${i}`, spoken: `say ${i}`, seconds: 5.4 })),
        cta: "Save this",
        hashtags: ["#pool", "swim", ""],
        whyItWorks: ["a", "b"],
      }),
    );
    expect(plan.beats).toHaveLength(10);
    expect(plan.beats[0]).toMatchObject({ label: "b0", spoken: "say 0", seconds: 5 });
    expect(plan.hashtags).toEqual(["pool", "swim"]);
  });

  it("throws on unusable plans", () => {
    expect(() => parseReelPlan('{"title":"x","beats":[]}')).toThrow(/unusable reel/);
    expect(() => parseCarouselPlan('{"slides":[{"headline":"only one"}]}')).toThrow(/unusable carousel/);
    expect(() => parseAdPlan('{"variants":[{"headline":"no body"}]}')).toThrow(/unusable ad/);
    expect(() => parseFreePlan('{"title":"x"}')).toThrow(/empty/);
  });

  it("renumbers carousel slides and accepts snake_case", () => {
    const plan = parseCarouselPlan(
      JSON.stringify({ slides: [{ n: 7, headline: "Hook" }, { title: "Two", text: "body" }], why_it_works: ["w"] }),
    );
    expect(plan.slides.map((s) => s.n)).toEqual([1, 2]);
    expect(plan.slides[1]).toMatchObject({ headline: "Two", body: "body" });
    expect(plan.whyItWorks).toEqual(["w"]);
  });

  it("maps kinds to parsers", () => {
    const out = PLAN_PARSERS.free('{"title":"A","markdown":"## Hi"}');
    expect(out).toEqual({ kind: "free", plan: { title: "A", markdown: "## Hi" } });
  });
});
