import { describe, expect, it } from "vitest";
import { allIn, asIn, sharedAgainIn, withoutWorkspace } from "./rule-workspaces";

const rule = (x: object) => ({ id: "r", updatedAt: 1, text: "shared", ...x });

describe("rule-workspaces", () => {
  it("a workspace's version is used there under the shared id; one kept elsewhere is not there", () => {
    const r = rule({ versions: { b: { text: "b's", updatedAt: 2 } } });
    expect(asIn(r, "a")).toEqual({ id: "r", updatedAt: 1, text: "shared" });
    expect(asIn(r, "b")).toEqual({ id: "r", updatedAt: 2, text: "b's", changedHere: true });
    expect(allIn([rule({ only: ["a"] })], "b")).toEqual([]);
    expect(sharedAgainIn(r, "b")).toEqual({ id: "r", updatedAt: 1, text: "shared" });
  });

  it("a deleted workspace: off every list, a list left empty deletes it, its version goes", () => {
    expect(withoutWorkspace(rule({ only: ["a"] }), "a")).toBe("delete");
    expect(withoutWorkspace(rule({ only: ["a", "b"] }), "a")).toEqual(rule({ only: ["b"] }));
    expect(withoutWorkspace(rule({ versions: { a: { text: "x", updatedAt: 2 } } }), "a")).toEqual(rule({}));
    expect(withoutWorkspace(rule({ only: ["b"] }), "a")).toBeNull();
  });
});
