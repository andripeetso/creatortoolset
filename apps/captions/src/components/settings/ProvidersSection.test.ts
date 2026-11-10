import { describe, expect, it } from "vitest";
import { shortVersion } from "./ProvidersSection";

describe("shortVersion", () => {
  it("keeps the number a person reads from what each tool prints", () => {
    expect(shortVersion("2.1.321 (Claude Code)")).toBe("2.1.321");
    expect(shortVersion("codex-cli 0.39.0")).toBe("0.39.0");
    expect(shortVersion("grok 1.0.4 (d846eb93d94d)")).toBe("1.0.4");
    expect(shortVersion("1.18.31")).toBe("1.18.31");
  });

  it("leaves a version with no number, or none at all, as it is", () => {
    expect(shortVersion("nightly")).toBe("nightly");
    expect(shortVersion(undefined)).toBeUndefined();
  });
});
