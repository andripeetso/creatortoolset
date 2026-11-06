import { describe, expect, it } from "vitest";
import { foldProjectInstructions } from "./workshop";

describe("project instructions", () => {
  it("folds old audience, voice and CTA into instructions", () => {
    expect(foldProjectInstructions({ notes: "never medical", audience: "parents", voice: "warm", cta: "save it" })).toBe(
      "never medical\n\nAudience: parents\n\nVoice: warm\n\nCTA: save it",
    );
    expect(foldProjectInstructions({ notes: "", audience: "", voice: "", cta: "" })).toBe("");
  });
});
