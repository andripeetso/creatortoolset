import { describe, expect, it } from "vitest";
import {
  countReplies,
  finalizeComments,
  ingestCommentsPayload,
  mergeComments,
  newCommentStore,
  storeSize,
} from "./comments";

const node = (pk: string, text: string, extra: Record<string, unknown> = {}) => ({
  pk,
  text,
  created_at: 1_700_000_000 + Number(pk),
  user: { pk: `u${pk}`, username: `user${pk}` },
  comment_like_count: 3,
  child_comment_count: 0,
  ...extra,
});

const page1 = {
  data: {
    xdt_api__v1__media__media_id__comments__connection: {
      edges: [
        {
          node: node("1", "Great breakdown, saving this", {
            child_comment_count: 2,
            preview_child_comments: [node("11", "same here")],
          }),
        },
        { node: node("2", "🔥🔥🔥") },
      ],
      page_info: { has_next_page: true, end_cursor: "cursor-2" },
    },
  },
};

describe("ingestCommentsPayload", () => {
  it("pulls comments, preview replies, and the cursor out of a GraphQL page", () => {
    const store = newCommentStore();
    expect(ingestCommentsPayload(page1, store)).toBe(3);
    expect(store.top.size).toBe(2);
    expect(store.replies.get("1")?.size).toBe(1);
    expect(store.hasNext).toBe(true);
    expect(store.endCursor).toBe("cursor-2");
    expect(storeSize(store)).toBe(3);
    const first = store.top.get("1")!;
    expect(first).toMatchObject({
      id: "1",
      text: "Great breakdown, saving this",
      createdAt: 1_700_000_001_000,
      user: { username: "user1", id: "u1" },
      likeCount: 3,
      replyCount: 2,
    });
  });

  it("dedupes when the same page is seen twice", () => {
    const store = newCommentStore();
    ingestCommentsPayload(page1, store);
    expect(ingestCommentsPayload(page1, store)).toBe(3);
    expect(storeSize(store)).toBe(3);
  });

  it("attaches a replies query to its parent without touching the top cursor", () => {
    const store = newCommentStore();
    ingestCommentsPayload(page1, store);
    const replies = {
      data: {
        xdt_api__v1__media__media_id__comments__comment_id__child_comments: {
          edges: [{ node: node("12", "second reply") }, { node: node("11", "same here") }],
          page_info: { has_next_page: false, end_cursor: null },
        },
      },
    };
    ingestCommentsPayload(replies, store, { parentId: "1" });
    expect(store.replies.get("1")?.size).toBe(2);
    expect(store.hasNext).toBe(true);
    expect(store.endCursor).toBe("cursor-2");
  });

  it("closes the cursor when the last page arrives", () => {
    const store = newCommentStore();
    ingestCommentsPayload(page1, store);
    ingestCommentsPayload(
      {
        data: {
          xdt_api__v1__media__media_id__comments__connection: {
            edges: [{ node: node("3", "late to the party") }],
            page_info: { has_next_page: false, end_cursor: null },
          },
        },
      },
      store,
    );
    expect(store.hasNext).toBe(false);
    expect(store.top.size).toBe(3);
  });

  it("understands the REST-style comments array too", () => {
    const store = newCommentStore();
    ingestCommentsPayload(
      { comments: [node("5", "rest style"), node("6", "still works")], next_min_id: "{}" },
      store,
    );
    expect(store.top.size).toBe(2);
    expect(store.hasNext).toBe(true);
  });

  it("ignores things that merely look like comments", () => {
    const store = newCommentStore();
    expect(ingestCommentsPayload({ data: { user: { username: "x" }, text: "not a comment" } }, store)).toBe(
      0,
    );
    expect(store.hits).toBe(0);
  });
});

describe("finalizeComments / mergeComments", () => {
  it("returns top-level comments with their replies in order", () => {
    const store = newCommentStore();
    ingestCommentsPayload(page1, store);
    const list = finalizeComments(store);
    expect(list.map((c) => c.id)).toEqual(["1", "2"]);
    expect(list[0].replies.map((r) => r.id)).toEqual(["11"]);
    expect(countReplies(list)).toBe(1);
  });

  it("merges a fresh collection into a stored one without duplicates", () => {
    const store = newCommentStore();
    ingestCommentsPayload(page1, store);
    const stored = finalizeComments(store);
    const fresh = [
      { ...stored[0], likeCount: 9, replies: [{ ...stored[0].replies[0] }, { ...stored[0].replies[0], id: "13", text: "new" }] },
      { ...stored[1], id: "7", text: "brand new" },
    ];
    const merged = mergeComments(stored, fresh);
    expect(merged.map((c) => c.id)).toEqual(["1", "2", "7"]);
    expect(merged[0].likeCount).toBe(9);
    expect(merged[0].replies.map((r) => r.id)).toEqual(["11", "13"]);
  });
});
