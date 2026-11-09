import { describe, expect, it } from "vitest";
import type { EditSummary } from "@contracts/editor";
import type { ReviewAsset } from "@/lib/review";
import { todoRows } from "./HomeTodo";

const edit = (id: string, state: EditSummary["last"]): EditSummary => ({
  id,
  name: `Tiny Acrobatics ${id}`,
  createdBy: "tinyacrobatics",
  createdAt: 0,
  updatedAt: 0,
  sources: [],
  last: state,
});
const asset = (id: string, status: ReviewAsset["approval"]["status"]): ReviewAsset =>
  ({ id, name: `Clip ${id}`, approval: { status }, versions: [], download: false, createdAt: 0 }) as ReviewAsset;

describe("HomeTodo rows", () => {
  it("lists videos waiting for review and edits whose last step failed or needs a key", () => {
    const rows = todoRows(
      [edit("e1", { kind: "draft", state: "failed" }), edit("e2", { kind: "script", state: "needs_key" }), edit("e3", { kind: "preview", state: "done" })],
      [asset("a1", "needs_review"), asset("a2", "approved")],
    );
    expect(rows.map((r) => r.key)).toEqual(["r:a1", "e:e1", "e:e2"]);
    expect(rows[0].to).toBe("/review/a1");
    expect(rows[1].text).toContain("last step failed");
    expect(rows[2].icon).toBe("key");
  });

  it("is empty when nothing waits on the account", () => {
    expect(todoRows([edit("e1", null)], [asset("a1", "none")])).toEqual([]);
  });
});
