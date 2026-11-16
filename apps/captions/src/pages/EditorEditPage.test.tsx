// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { EditJob } from "@contracts/editor";
import { stepLine } from "./EditorEditPage";

// The line beside a step on the edit page: the computer working on it, with bytes and time left, or why it waits.

const job = (more: Partial<EditJob>): EditJob => ({ id: 1, kind: "analyze", variant: "", state: "running", attempts: 0, error: null, ...more });

describe("the edit page's step line", () => {
  it("names the computer working on the step, with the download's bytes and time left", () => {
    expect(stepLine(job({ line: "downloading 2 of 13 proxies", progress: { device: "Mac Studio", done: 340e6, total: 1.2e9, leftS: 180 } }))).toBe(
      "Mac Studio: downloading 2 of 13 proxies, 340 MB of 1.2 GB, about 3 min left",
    );
    expect(stepLine(job({ progress: { device: "Mac Studio", done: 0, total: 3.4e9, leftS: 30 } }))).toBe("Mac Studio: 0 MB of 3.4 GB, under a minute left");
    expect(stepLine(job({ progress: { device: "Mac mini" } }))).toBe("Mac mini");
  });

  it("a step on the server keeps its own line, and nothing when it says nothing (fine = no label)", () => {
    expect(stepLine(job({ line: "Waiting for your AI" }))).toBe("Waiting for your AI");
    expect(stepLine(job({}))).toBeUndefined();
  });

  it("a queued step shows the wait line as it comes", () => {
    for (const line of ["Waits for one of your computers. Open Creator Toolset on your Mac", "Update Creator Toolset on Mac Studio"]) {
      expect(stepLine(job({ state: "queued", line }))).toBe(line);
    }
  });
});
