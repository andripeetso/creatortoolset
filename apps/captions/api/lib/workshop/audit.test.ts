import { describe, expect, it } from "vitest";
import { applyAuditWording, auditEdits, auditSummaryText, countVerdicts, documentAudit, parseAuditResult, splitSources } from "./audit";
import { applyEdits, newDocument } from "./doc";

describe("documentAudit", () => {
  it("marks every block with its id", () => {
    const doc = newDocument("d1", "s1", "carousel", "Sample", { text: "Hook\n\nA study of 7000 kids", author: "ai", now: 1 });
    const t = documentAudit(doc).text;
    expect(t).toContain('Piece: "Sample" (carousel)');
    expect(t).toContain("[b1] Hook");
    expect(t).toContain("[b2] A study of 7000 kids");
  });

  it("marks reel hook variations so fixes can land on a card", () => {
    const doc = newDocument("d1", "s1", "reel", "Reel", { text: "The script body", author: "ai", now: 1 });
    applyEdits(doc, [{ op: "add_hook", text: "A window closes at nine months" }]);
    const t = documentAudit(doc).text;
    expect(t).toContain("[h1] A window closes at nine months");
    expect(t).toContain("[b1] The script body");
  });
});

describe("documentAudit coverage", () => {
  it("says how much of a long piece the audit read, and the summary says it too", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Slide ${i} ${"w".repeat(1000)}`).join("\n\n");
    const doc = newDocument("d1", "s1", "carousel", "Long", { text: long, author: "ai", now: 1 });
    const a = documentAudit(doc);
    expect(a.covered?.chars).toBe(24_000);
    expect(a.covered!.total).toBeGreaterThan(24_000);
    expect(a.text).toContain(`The audit read the first 24,000 of ${a.covered!.total.toLocaleString("en-US")} characters`);
    expect(documentAudit(newDocument("d2", "s1", "carousel", "Short", { text: "One", author: "ai", now: 1 })).covered).toBeUndefined();
    const summary = auditSummaryText("Long", { score: 50, summary: "Mostly fine.", claims: [], citations: [], covered: a.covered });
    expect(summary).toContain(`Only the first 24,000 of ${a.covered!.total.toLocaleString("en-US")} characters of the piece were checked.`);
  });
});

describe("parseAuditResult", () => {
  it("reads claims, maps [n] references to citations, drops junk, keeps the score", () => {
    const r = parseAuditResult(
      '```json\n' +
        JSON.stringify({
          score: 41,
          summary: "The study exists but was about swimming.",
          claims: [
            { id: "c1", where: "b2", claim: "Merrow ran a study of early movement", verdict: "contradicted", confidence: 0.9, evidence: "The 2012 Merrow study was about swimming lessons [2].", sources: [{ title: "Merrow", url: "https://merrow.example.org/study" }], fix: "Merrow Institute studied early swimmers." },
            { claim: "7000 children took part", verdict: "supported", evidence: "Merrow surveyed 7000 parents [1]", sources: ["https://example.org/x", "not a url"] },
            { claim: "bad verdict", verdict: "maybe", evidence: "" },
            "junk",
          ],
        }) +
        "\n```",
      ["https://one.example/a", "https://two.example/b"],
    );
    expect(r.score).toBe(41);
    expect(r.summary).toContain("swimming");
    expect(r.claims).toHaveLength(2);
    expect(r.claims[0]).toMatchObject({ id: "c1", where: "b2", verdict: "contradicted", fix: "Merrow Institute studied early swimmers." });
    expect(r.claims[0]!.sources.map((s) => s.url)).toEqual(["https://merrow.example.org/study", "https://two.example/b"]);
    expect(r.claims[1]).toMatchObject({ id: "c2", verdict: "supported", confidence: 0.5 });
    expect(r.claims[1]!.sources.map((s) => s.url)).toEqual(["https://example.org/x", "https://one.example/a"]);
    expect(r.citations).toEqual(["https://one.example/a", "https://two.example/b"]);
  });

  it("scores from the verdicts when the model gives no score, and rejects an empty answer", () => {
    const r = parseAuditResult('{"claims":[{"claim":"a","verdict":"supported","evidence":"x"},{"claim":"b","verdict":"contradicted","evidence":"y"}]}');
    expect(r.score).toBe(50);
    expect(countVerdicts(r.claims)).toEqual({ supported: 1, partly: 0, contradicted: 1, unverifiable: 0 });
    expect(() => parseAuditResult('{"claims":[]}')).toThrow(/no claims/);
  });
});

describe("auditSummaryText", () => {
  it("counts verdicts and lists what is not supported, with fixes", () => {
    const r = parseAuditResult('{"score":70,"summary":"Mostly fine.","claims":[{"claim":"a","verdict":"supported","evidence":"x"},{"where":"b3","claim":"b","verdict":"partly","evidence":"narrower","fix":"b, narrowed"}]}');
    const t = auditSummaryText("Reel", r);
    expect(t).toContain("Accuracy audit of “Reel”: 70/100 — 1 supported, 1 partly, 0 contradicted, 0 unverifiable.");
    expect(t).toContain("- b3: b — partly. narrower Fix: b, narrowed");
    expect(t).not.toContain("- a —");
  });
});

describe("applyAuditWording", () => {
  it("replaces an exact span and leaves the rest", () => {
    const next = applyAuditWording("Alpha. Babies make 31,000 kicks a day. Omega.", "Babies make 31,000 kicks a day.", "Wearable sensors count tens of thousands of kicks a day.");
    expect(next).toBe("Alpha. Wearable sensors count tens of thousands of kicks a day. Omega.");
  });

  it("matches folded quotes and number words", () => {
    const next = applyAuditWording("There's a window that closes at around 9 months.", "There’s a window that closes at around nine months.", "There's an early period of varied movement.");
    expect(next).toBe("There's an early period of varied movement.");
  });

  it("returns null when the claim is not in the text", () => {
    expect(applyAuditWording("A short script about sleep.", "Babies who swim before five are months ahead.", "Swimming is one of many movement experiences.")).toBeNull();
  });
});

describe("auditEdits", () => {
  it("does not replace a reel page with the last fix", () => {
    const script = [
      "There's a window in your baby's brain development that closes at around 9 months.",
      "That's why I built Tiny Acrobatics. Short, research-backed movement routines that give your baby the varied movement experiences their brain actually needs.",
    ].join("\n\n");
    const doc = newDocument("d1", "s1", "reel", "Reel", { text: script, author: "ai", now: 1 });
    doc.caption = {
      text: "Then he spent the rest of his career showing the brain develops the same way: variation first, selection after. The immune system and the brain turn out to run on the same logic.",
      author: "ai",
      at: 1,
    };
    const { ops, appliedIds } = auditEdits(doc, [
      {
        id: "c1",
        where: "b1",
        claim: "There's a window in your baby's brain development that starts closing at around nine months.",
        fix: "There's a critical early period when your baby's brain is building movement repertoires.",
      },
      {
        id: "c2",
        where: "b1",
        claim: "Tiny Acrobatics consists of short, research-backed movement routines that give your baby the varied movement their brain needs during this exact window.",
        fix: "That's why I built Tiny Acrobatics: short movement routines inspired by research.",
      },
      {
        id: "c3",
        where: "caption",
        claim: "Then he spent the rest of his career showing the brain develops the same way: variation first, selection after.",
        fix: "After his immune-system work, Edelman developed Neural Darwinism.",
      },
      {
        id: "c4",
        where: "caption",
        claim: "The immune system and the brain turn out to run on the same logic.",
        fix: "Edelman argued that both follow a selection-based logic.",
      },
    ]);
    applyEdits(doc, ops);
    expect(appliedIds).toEqual(["c1", "c2", "c3", "c4"]);
    expect(doc.blocks[0]!.text).toContain("critical early period");
    expect(doc.blocks[0]!.text).toContain("inspired by research");
    expect(doc.blocks[0]!.text).not.toBe("That's why I built Tiny Acrobatics: short movement routines inspired by research.");
    expect(doc.caption!.text).toContain("Neural Darwinism");
    expect(doc.caption!.text).toContain("selection-based logic");
  });
});

describe("splitSources", () => {
  it("takes the Sources list off the answer, URLs in [n] order", () => {
    const r = splitSources("Babies who crawl [1] ... [3].\n\n**Sources:**\n[1] https://a.org/study.\n- [3] Title — https://c.org/x\n[2] (https://b.org/y)");
    expect(r.content).toBe("Babies who crawl [1] ... [3].");
    expect(r.citations).toEqual(["https://a.org/study", "https://b.org/y", "https://c.org/x"]);
  });

  it("leaves an answer without sources as it is", () => {
    expect(splitSources("No sources here.")).toEqual({ content: "No sources here.", citations: [] });
  });
});
