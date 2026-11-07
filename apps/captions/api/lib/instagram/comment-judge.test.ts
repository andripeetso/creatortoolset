import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../jev", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jev")>()),
  ask: vi.fn(),
}));

import { ask } from "../jev";
import { annotateComments, captionKeywords, judgeComments } from "./comment-judge";
import type { Comment } from "./types";

beforeEach(() => vi.clearAllMocks());

describe("keywords a caption asks people to comment", () => {
  it("reads the word after 'comment'", () => {
    expect(captionKeywords("Comment BABY MOVEMENT and I'll send you the guide")).toEqual(["baby movement"]);
    expect(captionKeywords('comment "potty" for the checklist')).toEqual(["potty"]);
  });

  it("ignores captions that only mention comments", () => {
    expect(captionKeywords("Half the comments under my videos say it's dangerous")).toEqual([]);
  });
});

describe("judging a post's comments", () => {
  it("asks three questions per comment and reads the answers back by comment", async () => {
    vi.mocked(ask).mockResolvedValueOnce({
      kind0: { choice: "question", confidence: 0.9 },
      worth0: { noul: 0.91 },
      answer0: { noul: 0.88 },
      kind1: { choice: "other", confidence: 0.8 },
      worth1: { noul: 0.05 },
      answer1: { noul: 0.02 },
    });
    const judged = await judgeComments("k", { caption: "Tummy time tips" }, [
      { id: "a", text: "What age can one start?" },
      { id: "b", text: "🔥🔥🔥" },
    ]);
    expect(Object.keys(vi.mocked(ask).mock.calls[0][2])).toEqual([
      "kind0",
      "worth0",
      "answer0",
      "kind1",
      "worth1",
      "answer1",
    ]);
    expect(judged.get("a")).toEqual({ kind: "question", worth: 0.91, needsAnswer: 0.88 });
    expect(judged.get("b")).toEqual({ kind: "other", worth: 0.05, needsAnswer: 0.02 });
  });

  it("labels a bare reply to the caption's keyword as a keyword, whatever Jev picked", async () => {
    vi.mocked(ask).mockResolvedValueOnce({
      kind0: { choice: "other" },
      worth0: { noul: 0.1 },
      answer0: { noul: 0.1 },
    });
    const judged = await judgeComments("k", { caption: "Comment POTTY and I'll send it" }, [
      { id: "a", text: "Potty!" },
    ]);
    expect(judged.get("a")?.kind).toBe("keyword");
  });

  it("sends at most 20 comments per request", async () => {
    vi.mocked(ask).mockResolvedValue({});
    const many = Array.from({ length: 45 }, (_, i) => ({ id: String(i), text: `comment ${i}` }));
    await judgeComments("k", {}, many);
    expect(ask).toHaveBeenCalledTimes(3);
  });
});

describe("marking a post's comments", () => {
  const cm = (id: string, text: string, extra: Partial<Comment> = {}): Comment => ({
    id,
    text,
    createdAt: 0,
    user: { username: "u", id: "" },
    likeCount: 0,
    replyCount: 0,
    replies: [],
    ...extra,
  });

  it("hides by Jev's worth score and counts questions and keyword replies", async () => {
        vi.mocked(ask).mockResolvedValueOnce({
      kind0: { choice: "question" }, worth0: { noul: 0.9 }, answer0: { noul: 0.85 },
      kind1: { choice: "keyword" }, worth1: { noul: 0.05 }, answer1: { noul: 0.01 },
      kind2: { choice: "pushback" }, worth2: { noul: 0.45 }, answer2: { noul: 0.1 },
    });
    // "Is it too late at 7 months" has no "?" — the word filter alone keeps it anyway,
    // "Scare tactics" the word filter would keep too; Jev scores both
    const list = [cm("a", "Is it too late at 7 months"), cm("b", "Blueprint"), cm("c", "Scare tactics honestly")];
    const tally = await annotateComments("k", list, { caption: "Comment BLUEPRINT for the guide" });
    expect(list.map((c) => c.lowValue)).toEqual([false, true, false]);
    expect(tally).toEqual({ filteredOut: 1, questions: 1, keywords: 1 });
  });

  it("keeps the word filter when there is no TypeSafe key", async () => {
    const list = [cm("a", "🔥🔥🔥"), cm("b", "How long should tummy time be each day?")];
    const tally = await annotateComments("", list, {});
    expect(ask).not.toHaveBeenCalled();
    expect(list.map((c) => c.lowValue)).toEqual([true, false]);
    expect(tally.filteredOut).toBe(1);
  });

  it("keeps the word filter when Jev fails", async () => {
        vi.mocked(ask).mockRejectedValueOnce(new Error("down"));
    const list = [cm("a", "🔥🔥🔥"), cm("b", "How long should tummy time be each day?")];
    await annotateComments("k", list, {});
    expect(list.map((c) => c.lowValue)).toEqual([true, false]);
    expect(list.every((c) => !c.judged)).toBe(true);
  });

  it("only asks about comments not judged yet", async () => {
        vi.mocked(ask).mockResolvedValueOnce({ kind0: { choice: "story" }, worth0: { noul: 0.8 }, answer0: { noul: 0.2 } });
    const done = cm("a", "old one", { judged: { kind: "praise", worth: 0.3, needsAnswer: 0 } });
    const list = [done, cm("b", "Sample comment about the rollout")];
    await annotateComments("k", list, {});
    expect(vi.mocked(ask).mock.calls[0][2]).toHaveProperty("kind0");
    expect(Object.keys(vi.mocked(ask).mock.calls[0][2])).toHaveLength(3);
    expect(list[1].judged?.kind).toBe("story");
  });
});
