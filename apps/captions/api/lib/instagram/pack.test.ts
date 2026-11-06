import { describe, expect, it } from "vitest";
import { fitPacks, selectTopComments, truncateMarkdown, SHORTENED_NOTE } from "./pack";
import type { Comment } from "./types";

const cm = (id: string, likes: number, extra: Partial<Comment> = {}): Comment => ({
  id,
  text: `comment ${id}`,
  createdAt: Number(id.replace(/\D/g, "")) || 0,
  user: { username: "u", id: "1" },
  likeCount: likes,
  replyCount: 0,
  replies: [],
  ...extra,
});

describe("selectTopComments", () => {
  it("drops low-value ones, sorts by likes, caps replies", () => {
    const list = [
      cm("c1", 2, { replies: [cm("r1", 0, { lowValue: true }), cm("r2", 5), cm("r3", 1), cm("r4", 9)] }),
      cm("c2", 50, { lowValue: true }),
      cm("c3", 7),
    ];
    const out = selectTopComments(list, 5, 2);
    expect(out.map((c) => c.id)).toEqual(["c3", "c1"]);
    expect(out[1]!.replies.map((r) => r.id)).toEqual(["r4", "r2"]);
    expect(selectTopComments(list, 1)).toHaveLength(1);
  });
});

describe("truncateMarkdown", () => {
  it("leaves short text alone and cuts long text at a line break", () => {
    expect(truncateMarkdown("abc", 10)).toEqual({ text: "abc", truncated: false });
    const md = `${"x".repeat(50)}\n${"y".repeat(50)}\n${"z".repeat(50)}`;
    const out = truncateMarkdown(md, 120);
    expect(out.truncated).toBe(true);
    expect(out.text.startsWith("x".repeat(50))).toBe(true);
    expect(out.text).not.toContain("z");
    expect(out.text.trimEnd().endsWith(SHORTENED_NOTE)).toBe(true);
  });

  it("hard-cuts when the last line break is too early", () => {
    const md = `a\n${"b".repeat(200)}`;
    expect(truncateMarkdown(md, 100).text.length).toBeLessThanOrEqual(100 + SHORTENED_NOTE.length + 3);
  });
});

const pack = (id: string, chars: number) => ({ id, markdown: "w".repeat(chars), chars });

describe("fitPacks", () => {
  it("returns packs untouched under budget", () => {
    const { packs, warning } = fitPacks([pack("a", 100), pack("b", 200)], { perPost: 500, total: 1000 });
    expect(packs.map((p) => p.chars)).toEqual([100, 200]);
    expect(packs.every((p) => !p.truncated)).toBe(true);
    expect(warning).toBeUndefined();
  });

  it("applies the per-post cap", () => {
    const { packs, warning } = fitPacks([pack("a", 900)], { perPost: 500, total: 1000, minKeep: 100 });
    expect(packs[0]!.truncated).toBe(true);
    expect(packs[0]!.chars).toBeLessThanOrEqual(500 + SHORTENED_NOTE.length + 3);
    expect(warning).toMatch(/1 of 1 source shortened/);
  });

  it("shares the total budget and spares small packs", () => {
    const { packs } = fitPacks([pack("small", 100), pack("big", 2000), pack("huge", 4000)], {
      perPost: 5000,
      total: 3000,
      minKeep: 200,
    });
    const [small, big, huge] = packs;
    expect(small!.truncated).toBe(false);
    expect(big!.truncated && huge!.truncated).toBe(true);
    expect(huge!.chars).toBeGreaterThan(big!.chars);
    expect(packs.reduce((n, p) => n + p.chars, 0)).toBeLessThanOrEqual(3000 + 3 * (SHORTENED_NOTE.length + 3));
  });

  it("refuses when even the floors do not fit", () => {
    expect(() => fitPacks([pack("a", 500), pack("b", 500)], { perPost: 500, total: 300, minKeep: 200 })).toThrow(
      /Too many sources/,
    );
  });
});
