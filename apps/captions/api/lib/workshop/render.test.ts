import { describe, expect, it } from "vitest";
import { renderDraft } from "./render";

const ctx = { projectName: "Sample", frameworkNames: ["PAS"], sources: [{ handle: "coach", kind: "reel", url: "https://x/1" }], generatedAt: Date.UTC(2026, 8, 14) };

const sectionOrder = (md: string, headings: string[]) => {
  let at = -1;
  for (const h of headings) {
    const next = md.indexOf(h, at + 1);
    expect(next, h).toBeGreaterThan(at);
    at = next;
  }
};

describe("renderDraft", () => {
  it("renders a reel with sections in order", () => {
    const md = renderDraft(
      {
        kind: "reel",
        plan: {
          title: "Pool day",
          hook: { spoken: "Stop", onScreen: "STOP" },
          beats: [{ label: "Problem", spoken: "adults sink", onScreen: "sink", visual: "pool", seconds: 6 }],
          cta: "Save it",
          caption: "cap",
          hashtags: ["pool"],
          whyItWorks: ["because"],
        },
      },
      ctx,
    );
    expect(md.startsWith("# Pool day\n\n_Reel script · Sample · PAS · 2026-09-14_")).toBe(true);
    sectionOrder(md, ["## Hook", "**Say:** Stop", "## Script", "### 1. Problem (~6 s)", "## CTA", "## Caption", "#pool", "## Why it works", "- because", "## Sources", "- @coach — reel — https://x/1"]);
    expect(md.endsWith("\n")).toBe(true);
  });

  it("renders carousels and ads", () => {
    const car = renderDraft({ kind: "carousel", plan: { title: "C", slides: [{ n: 1, headline: "Hook", body: "" }, { n: 2, headline: "Two", body: "b" }], caption: "", hashtags: [], whyItWorks: [] } }, ctx);
    sectionOrder(car, ["## Slide 1 — Hook", "## Slide 2 — Two", "## Sources"]);
    expect(car).not.toContain("## Caption");
    const ad = renderDraft({ kind: "ad", plan: { title: "A", variants: [{ angle: "pain", hook: "h", primaryText: "pt", headline: "hl", description: "d", cta: "Go" }], whyItWorks: [] } }, { ...ctx, sources: [] });
    sectionOrder(ad, ["## Variant A — pain", "**Primary text**", "pt", "**CTA:** Go"]);
    expect(ad).not.toContain("## Sources");
  });

  it("does not duplicate a free draft's own title", () => {
    const md = renderDraft({ kind: "free", plan: { title: "Ignored", markdown: "# Own title\n\ntext" } }, ctx);
    expect(md.startsWith("_Draft · Sample · PAS")).toBe(true);
    expect(md).not.toContain("# Ignored");
    const md2 = renderDraft({ kind: "free", plan: { title: "Given", markdown: "text" } }, ctx);
    expect(md2.startsWith("# Given\n")).toBe(true);
  });
});
