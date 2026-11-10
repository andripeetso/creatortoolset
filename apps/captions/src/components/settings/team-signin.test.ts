import { describe, expect, it } from "vitest";
import { signInId, signInOptions } from "./WorkspaceSection";

describe("How the team signs in offers only the sign-ins the server has on", () => {
  it("none on: only a password too (the page then shows it as plain text)", () => {
    expect(signInOptions([]).map((o) => o.id)).toEqual(["any"]);
  });

  it("one on: a password too, and that one alone", () => {
    expect(signInOptions(["github"]).map((o) => [o.id, o.label])).toEqual([
      ["any", "Any way (password too)"],
      ["github", "GitHub only"],
    ]);
  });

  it("all three on: each alone, then all three together as one choice", () => {
    const opts = signInOptions(["google", "apple", "github"]);
    expect(opts.map((o) => o.id)).toEqual(["any", "google", "apple", "github", "all"]);
    expect(opts.at(-1)).toMatchObject({ label: "Google, Apple or GitHub", value: ["google", "apple", "github"] });
    expect(signInId(opts, ["github", "google", "apple"])).toBe("all");
    expect(signInId(opts, [])).toBe("any");
  });

  it("a choice whose sign-in is now switched off stays visible, so what is shown is what is enforced", () => {
    const opts = signInOptions(["google"], ["apple"]);
    expect(opts.map((o) => o.id)).toEqual(["any", "google", "saved"]);
    expect(signInId(opts, ["apple"])).toBe("saved");
  });
});
