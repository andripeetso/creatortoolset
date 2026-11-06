import { describe, expect, it } from "vitest";
import type { Comment } from "../instagram/types";
import { buildAnswerPrompt, CHAT_BUDGET, listComments } from "./answers";

const c = (id: string, user: string, text: string, extra: Partial<Comment> = {}): Comment => ({ id, text, createdAt: 1, user: { username: user, id: user }, likeCount: 0, replyCount: 0, replies: [], ...extra });

describe("listComments", () => {
  it("marks questions, and the ones the account already replied to", () => {
    const rows = listComments(
      [
        c("1", "anna", "How did they rule out income?", { replies: [c("1a", "tinyacrobatics", "They split by postcode")] }),
        c("2", "ben", "Love this", { judged: { kind: "praise", worth: 0.3, needsAnswer: 0.01 } }),
        c("3", "cara", "is this for preemies too", { judged: { kind: "question", worth: 0.9, needsAnswer: 0.9 } }),
        c("4", "tinyacrobatics", "Pinned: sources below"),
      ],
      "tinyacrobatics",
    );
    expect(rows.map((r) => [r.id, r.question, r.answered])).toEqual([
      ["1", true, true],
      ["2", false, false],
      ["3", true, false],
    ]);
  });
});

describe("buildAnswerPrompt", () => {
  it("has the post, the chat's newest messages within the budget, the comments, and the clicked comment", () => {
    const old = { role: "user" as const, text: "x".repeat(CHAT_BUDGET) };
    const { user } = buildAnswerPrompt({
      pieces: ["## Carousel (carousel)\n\nSlide one"],
      notes: "",
      chat: [old, { role: "assistant", text: "The report can't show causation (p. 56)." }],
      comments: [c("9", "dan", "Was causality clear?")],
      handle: "tinyacrobatics",
      replies: [{ comment: "source?", reply: "Merrow 2013 🙂" }],
      thread: [],
      question: "",
      comment: c("9", "dan", "Was causality clear?"),
    });
    expect(user).toContain("Slide one");
    expect(user).toContain("can't show causation");
    expect(user).toContain("1 earlier message is not shown");
    expect(user).not.toContain("xxxxxxxxxx");
    expect(user).toContain("Merrow 2013");
    expect(user.endsWith("> @dan: Was causality clear?")).toBe(true);
  });
});
