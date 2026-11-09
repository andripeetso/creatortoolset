import { describe, expect, it } from "vitest";
import { sessionsIndex, type OwnPost } from "./folder";
import { linkCandidates, matchPosted, postedFromUrl } from "./posted";

const DAY = 86_400_000;
const post = (shortcode: string, takenAt: number, caption: string, extra: Partial<OwnPost> = {}): OwnPost =>
  ({ item: { shortcode, url: `https://www.instagram.com/p/${shortcode}/`, kind: "carousel", takenAt, caption, counts: {}, insights: { views: 20000, saved: 300, shares: 100 } }, from: "feed", ...extra }) as OwnPost;
const session = (id: string, createdAt: number, postedNot?: string[]) => ({ id, createdAt, postedNot });

const BEANS = "Coffee tastes sweeter next to the window. Most roasters have left the light out. Morning sun at the counter was linked to fewer rushed cups and fewer burnt batches.";
const TOOLS = "Our kitchen has its own knives and peelers, and it has used both since day one. Kitchen tools can be sharpened.";
const STALE = "Why bread goes stale fast: a cold fridge dries the crumb, and a warm counter moulds it.";

describe("matchPosted", () => {
  const posts = [
    post("BEANS1", 10 * DAY, "Coffee by the window", { slides: ["Coffee tastes sweeter next to the window", "Morning sun at the counter linked to fewer rushed cups"] }),
    post("TOOLS1", 10 * DAY, TOOLS),
    post("STALE1", 2 * DAY, STALE),
  ];

  it("links each session to the post its words clearly became", () => {
    const got = matchPosted([{ meta: session("a", 5 * DAY), text: BEANS }, { meta: session("b", 5 * DAY), text: TOOLS }], posts);
    expect(got.get("a")?.item.shortcode).toBe("BEANS1");
    expect(got.get("b")?.item.shortcode).toBe("TOOLS1");
  });

  it("never links a post older than the session, a post the author marked as not this session's, or one another session holds", () => {
    expect(matchPosted([{ meta: session("c", 5 * DAY), text: STALE }], posts).size).toBe(0);
    expect(matchPosted([{ meta: session("a", 5 * DAY, ["BEANS1"]), text: BEANS }], posts).size).toBe(0);
    expect(matchPosted([{ meta: session("a", 5 * DAY), text: BEANS }], posts, new Set(["BEANS1"])).size).toBe(0);
  });

  it("leaves a tie between two near-identical posts unlinked", () => {
    const twins = [post("T1", 10 * DAY, TOOLS), post("T2", 11 * DAY, TOOLS)];
    expect(matchPosted([{ meta: session("b", 5 * DAY), text: TOOLS }], twins).size).toBe(0);
  });
});

describe("postedFromUrl", () => {
  it("reads post, reel and profile-prefixed links, and refuses the rest", () => {
    expect(postedFromUrl("https://www.instagram.com/reel/DQx1abcDEF/?igsh=xyz")).toEqual({ shortcode: "DQx1abcDEF", url: "https://www.instagram.com/p/DQx1abcDEF/" });
    expect(postedFromUrl("instagram.com/tinyacrobatics/p/DQx1abcDEF")?.shortcode).toBe("DQx1abcDEF");
    expect(postedFromUrl("https://example.com/p/DQx1abcDEF")).toBeNull();
    expect(postedFromUrl("https://www.instagram.com/tinyacrobatics/")).toBeNull();
  });
});

describe("sessionsIndex", () => {
  it("lists linked sessions with the post's numbers, then ones in production with no post", () => {
    const out = sessionsIndex(
      [
        { id: "aaaaaa11", title: "TinyAcrobatics", createdAt: 5 * DAY, status: "published", posted: { shortcode: "BEANS1", url: "https://www.instagram.com/p/BEANS1/", by: "auto", at: 1 } },
        { id: "bbbbbb22", title: "Knife", createdAt: 5 * DAY, status: "production" },
        { id: "cccccc33", title: "Draft", createdAt: 5 * DAY, status: "writing" },
      ],
      [post("BEANS1", 10 * DAY, BEANS)],
    )!;
    expect(out).toContain("| 1970-01-06-tinyacrobatics-aaaaaa.md | TinyAcrobatics | my-posts/1970-01-11-BEANS1.md | 20,000 | 20.0 |");
    expect(out).toContain("- 1970-01-06-knife-bbbbbb.md (Knife)");
    expect(out).not.toContain("Draft");
    expect(sessionsIndex([{ id: "cccccc33", title: "Draft", createdAt: 1, status: "writing" }], [])).toBeUndefined();
  });

  it("gives every post of a session its own row, and counts each post", () => {
    const out = sessionsIndex(
      [
        {
          id: "aaaaaa11",
          title: "TinyAcrobatics",
          createdAt: 5 * DAY,
          status: "published",
          postings: [
            { shortcode: "BEANS1", url: "https://www.instagram.com/p/BEANS1/", by: "auto", at: 1, version: "2294" },
            { shortcode: "TOOLS1", url: "https://www.instagram.com/p/TOOLS1/", by: "you", at: 2, version: "2296" },
          ],
          posted: { shortcode: "BEANS1", url: "https://www.instagram.com/p/BEANS1/", by: "auto", at: 1 },
        },
      ],
      [post("BEANS1", 10 * DAY, BEANS), post("TOOLS1", 11 * DAY, TOOLS)],
    )!;
    expect(out).toContain("# Workshop sessions and the posts they became (2)");
    expect(out).toContain("| 1970-01-06-tinyacrobatics-aaaaaa.md | TinyAcrobatics | my-posts/1970-01-11-BEANS1.md | 20,000 | 20.0 |");
    expect(out).toContain("| 1970-01-06-tinyacrobatics-aaaaaa.md | TinyAcrobatics | my-posts/1970-01-12-TOOLS1.md | 20,000 | 20.0 |");
  });
});

describe("linkCandidates", () => {
  const meta = (id: string, extra: Record<string, unknown> = {}) => ({ id, createdAt: 5 * DAY, status: "editing", ...extra }) as never;

  it("offers a session that already has another post, since one session can be several posts", () => {
    const withPost = meta("a", { postings: [{ shortcode: "BEANS1", url: "u", by: "auto", at: 1 }] });
    const plain = meta("b");
    expect(linkCandidates([withPost, plain] as never, "TOOLS1").map((m) => (m as { id: string }).id)).toEqual(["a", "b"]);
  });

  it("leaves out a shelved session, one the author said is not this post, and a session that holds this post already", () => {
    const shelved = meta("s", { status: "shelved" });
    const notThis = meta("n", { postedNot: ["TOOLS1"] });
    const holds = meta("h", { posted: { shortcode: "TOOLS1", url: "u", by: "you", at: 1 } });
    const open = meta("o");
    expect(linkCandidates([shelved, notThis, holds, open] as never, "TOOLS1").map((m) => (m as { id: string }).id)).toEqual(["o"]);
  });
});
