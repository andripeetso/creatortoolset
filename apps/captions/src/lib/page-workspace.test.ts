import { describe, expect, it } from "vitest";
import { leaveFor } from "./page-workspace";

describe("leaveFor: where a page goes when the workspace changes", () => {
  it("a page of one thing goes to its tool's own page", () => {
    expect(leaveFor("/review/v1")).toBe("/review");
    expect(leaveFor("/workshop/sessions/s1")).toBe("/workshop");
    expect(leaveFor("/finals/p1")).toBe("/finals");
    expect(leaveFor("/editor/e1")).toBe("/editor");
    expect(leaveFor("/analyzer/accounts/a1")).toBe("/analyzer");
  });
  it("a tool's page with one thing open in its address goes to the plain page", () => {
    expect(leaveFor("/library", "?clip=c1")).toBe("/library");
    expect(leaveFor("/captions", "?clip=c1")).toBe("/captions");
    expect(leaveFor("/review", "?p=folder")).toBe("/review");
  });
  it("a tool's own page, a page of no workspace and a share link stay", () => {
    expect(leaveFor("/review")).toBeNull();
    expect(leaveFor("/")).toBeNull();
    expect(leaveFor("/settings/general")).toBeNull();
    expect(leaveFor("/r/token")).toBeNull();
    expect(leaveFor("/library/s/token")).toBeNull();
    expect(leaveFor("/clips/f/token")).toBeNull();
    expect(leaveFor("/reviewers")).toBeNull();
  });
});
