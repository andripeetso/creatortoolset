// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { Me } from "@/lib/auth";
import { blurState, faceBlurOn, keptAsFilmed, rememberKeepAsFilmed } from "./face-blur";

const me = (role: string, off: string[] = []) => ({ role, off }) as unknown as Me;
const installed = [{ id: "blur-faces" }];

describe("faceBlurOn", () => {
  it("needs the plug-in, the account's gate and the workspace", () => {
    expect(faceBlurOn(me("member"), {}, "w1", [])).toBe(false);
    expect(faceBlurOn(me("member"), {}, "w1", installed)).toBe(true);
    expect(faceBlurOn(me("member", ["blur-faces"]), {}, "w1", installed)).toBe(false);
    expect(faceBlurOn(me("admin", ["blur-faces"]), {}, "w1", installed)).toBe(true);
    expect(faceBlurOn(me("admin"), { w1: ["blur-faces"] }, "w1", installed)).toBe(false);
    expect(faceBlurOn(me("admin"), { w1: ["blur-faces"] }, "w2", installed)).toBe(true);
    expect(faceBlurOn(null, {}, "w1", installed)).toBe(false);
  });
});

describe("blurState", () => {
  const auto = { can: true, running: ["v2"], failed: [{ versionId: "v3", title: "x", error: "e" }] };
  it("reads the file's state from GET /auto", () => {
    expect(blurState("v1", false, auto)).toBeNull();
    expect(blurState("v1", true, auto)).toEqual({ kind: "queued" });
    expect(blurState("v2", true, auto)).toEqual({ kind: "running" });
    expect(blurState("v3", true, auto)).toEqual({ kind: "failed" });
    expect(blurState("v3", true, null)).toEqual({ kind: "queued" });
  });
});

describe("keep as filmed", () => {
  it("is remembered per library", () => {
    localStorage.clear();
    rememberKeepAsFilmed("a", true);
    rememberKeepAsFilmed("b", true);
    rememberKeepAsFilmed("a", false);
    expect(keptAsFilmed()).toEqual(["b"]);
  });
});
