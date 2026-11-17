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
  it("a plug-in's page of one workspace's things goes where the plug-in says, ahead of the tools", () => {
    const pages = [{ path: /^\/footage(\/|$)/, to: "/library" }, { path: /^\/editor\/plugged\//, to: "/editor/plugged" }];
    expect(leaveFor("/footage", "", pages)).toBe("/library");
    expect(leaveFor("/footage", "?clip=c1", pages)).toBe("/library");
    expect(leaveFor("/footage/c1", "", pages)).toBe("/library");
    expect(leaveFor("/editor/plugged/e1", "", pages)).toBe("/editor/plugged");
    // its own landing page stays; the other pages are the tools' as before
    expect(leaveFor("/editor/plugged", "", [{ path: /^\/editor\/plugged/, to: "/editor/plugged" }])).toBeNull();
    expect(leaveFor("/review/v1", "", pages)).toBe("/review");
    expect(leaveFor("/footage")).toBeNull();
  });
});
