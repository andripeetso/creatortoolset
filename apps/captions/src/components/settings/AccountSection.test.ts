import { describe, expect, it } from "vitest";
import { signInNameProblem, signInReturn } from "./AccountSection";

describe("signInNameProblem (the allowed sign-in name, shown only when broken)", () => {
  it("is quiet for an allowed name, any case, and while nothing is typed", () => {
    expect(signInNameProblem("")).toBeNull();
    expect(signInNameProblem("  Andri-2_x ")).toBeNull();
  });

  it("names the rule for a name that breaks it", () => {
    expect(signInNameProblem("a")).not.toBeNull();
    expect(signInNameProblem("andri peetso")).not.toBeNull();
    expect(signInNameProblem("-andri")).not.toBeNull();
  });
});

describe("signInReturn (the toast after a sign-in link)", () => {
  it("says a linked provider by its name", () => {
    expect(signInReturn("?linked=google")).toEqual({ tone: "success", text: "Google is linked to your account." });
    expect(signInReturn("linked=github")).toEqual({ tone: "success", text: "GitHub is linked to your account." });
  });

  it("shows the server's message as an error, whatever else is in the query", () => {
    expect(signInReturn("?signin=Finish%20linking%20in%20the%20browser%20you're%20signed%20in%20on")).toEqual({
      tone: "error",
      text: "Finish linking in the browser you're signed in on",
    });
  });

  it("ignores a provider it does not know, and any other page", () => {
    expect(signInReturn("?linked=myspace")).toBeNull();
    expect(signInReturn("?tab=profile")).toBeNull();
    expect(signInReturn("")).toBeNull();
  });
});
