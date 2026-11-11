import { describe, expect, it } from "vitest";
import type { EditSummary } from "@contracts/editor";
import type { ReviewAsset } from "@/lib/review";
import type { ActivityRow } from "@contracts/activity";
import type { SessionSummary } from "@/lib/workshop-summary";
import { activityLines, runningByTile, todoRows } from "./HomeActivity";

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

describe("todoRows", () => {
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

const row = (id: string, href: string, more: Partial<ActivityRow> = {}): ActivityRow => ({ id, title: "Media Library", detail: `Row ${id}`, state: "working", href, ...more });
const session = (id: string, working: boolean, ready: boolean) => ({ id, title: `Tiny ${id}`, working, ready }) as SessionSummary;
const limit = "Your Claude plan's weekly limit is reached; it resets 5pm. They carry on by themselves then.";

describe("activityLines", () => {
  it("puts working rows and replies being written under Running, and what needs you under Waiting on you", () => {
    const { running, waiting } = activityLines(
      [row("l", "/library"), row("k", "/library", { state: "ready" }), row("mac", "/editor", { actions: [{ id: "s", title: "Stop", run: "stop", label: "x" }] })],
      [session("s1", true, false), session("s2", false, true), session("s3", false, false)],
      [{ key: "r:a1", to: "/review/a1", text: "Clip a1 is waiting for your review", icon: "review" }],
    );
    expect(running.map((l) => l.key)).toEqual(["l", "s:s1"]);
    expect(waiting.map((l) => l.key)).toEqual(["r:a1", "s:s2", "k"]);
    expect(running[1].to).toBe("/workshop/sessions/s1");
  });
});

describe("runningByTile", () => {
  it("says how far the library is, how many edits and exports run, and how many replies are being written", () => {
    const chips = runningByTile(
      [row("a", "/library", { progress: 0.45 }), row("e1", "/editor/e1"), row("e2", "/editor/e2"), row("x", "/captions?project=p")],
      2,
    );
    expect(chips["/library"]).toMatchObject({ text: "45%", moving: true });
    expect(chips["/editor"]).toMatchObject({ text: "2 editing", moving: true });
    expect(chips["/captions?view=projects"]?.text).toBe("1 exporting");
    expect(chips["/workshop"]?.text).toBe("2 writing");
  });

  it("says when work held by a plan's limit carries on, without a spinner, and nothing for a tool with no work", () => {
    const chips = runningByTile([row("l", "/library", { reason: limit })], 0);
    expect(chips).toEqual({ "/library": { text: "until 5pm", title: limit, moving: false } });
    expect(runningByTile([row("r", "/library", { state: "ready" })], 0)).toEqual({});
  });
});
