import { describe, expect, it } from "vitest";
import { makeEmbedding } from "./embed";
import { buildFindDoc, queryTerms, rankFind, stem, termInSet, termsOf, type FindDocInput } from "./find";

const doc = (over: Partial<FindDocInput> & { id: string }) =>
  buildFindDoc({
    kind: "reel",
    idea: [],
    slides: [],
    transcript: "",
    caption: [],
    comments: "",
    vector: makeEmbedding(over.id).vector,
    virality: 0,
    takenAt: 0,
    ...over,
  });

describe("stem / termsOf", () => {
  it("stems the common English endings", () => {
    const table: Array<[string, string]> = [
      ["plants", "plant"],
      ["gardening", "garden"],
      ["running", "run"],
      ["sleeping", "sleep"],
      ["babies", "baby"],
      ["classes", "class"],
      ["boxes", "box"],
      ["walked", "walk"],
      ["stopped", "stop"],
      ["speed", "speed"],
      ["bus", "bus"],
      ["yes", "yes"],
      ["thing", "thing"],
      ["falling", "fall"],
      ["kid's", "kid"],
    ];
    for (const [input, want] of table) expect(stem(input), input).toBe(want);
  });

  it("drops stopwords, hashes and duplicates", () => {
    expect(queryTerms("plants and gardening")).toEqual(["plant", "garden"]);
    expect(termsOf("#Gardening plants, PLANTS! the plant")).toEqual(["garden", "plant"]);
    expect(queryTerms("the and of")).toEqual([]);
  });
});

describe("rankFind", () => {
  const caption = doc({ id: "caption", caption: ["Our plant routine"], virality: 10 });
  const both = doc({ id: "both", transcript: "we garden in the plant every week", virality: 5 });
  const commentsOnly = doc({ id: "comments", comments: "plant!!", virality: 1000 });
  const unrelated = doc({ id: "other", caption: ["Sleep training tips"] });
  const phrase = doc({ id: "phrase", slides: ["plants and gardening for visitors"] });

  it("ranks coverage and where the words come from, and drops non-matches", () => {
    const hits = rankFind("plants and gardening", [caption, both, commentsOnly, unrelated]);
    expect(hits.map((h) => h.id)).toEqual(["both", "caption"]);
    expect(hits[0]!.matches).toEqual([{ term: "plant", field: "transcript" }, { term: "garden", field: "transcript" }]);
    expect(hits[1]!.matches).toEqual([{ term: "plant", field: "caption" }]);
    expect(hits[0]!.commentsOnly).toBe(false);
  });

  it("reports the most valuable field per term", () => {
    const d = doc({ id: "d", slides: ["plant day"], caption: ["plant plant plant"], comments: ["garden"].join(" ") });
    const [hit] = rankFind("plant garden", [d]);
    expect(hit!.matches).toEqual([{ term: "plant", field: "slides" }]);
    const slidesFirst = doc({ id: "s", slides: ["plant"] });
    const captionOnly = doc({ id: "c", caption: ["plant"], virality: 99 });
    expect(rankFind("plant", [captionOnly, slidesFirst]).map((h) => h.id)).toEqual(["s", "c"]);
  });

  it("gives a contiguous phrase a bonus", () => {
    const hits = rankFind("plants and gardening", [both, phrase]);
    expect(hits[0]!.id).toBe("phrase");
  });

  it("filters by kind and applies the limit", () => {
    const post = doc({ id: "post", kind: "post", caption: ["plant"] });
    expect(rankFind("plant", [caption, post], { kind: "post" }).map((h) => h.id)).toEqual(["post"]);
    expect(rankFind("plant", [caption, post, both], { limit: 2 })).toHaveLength(2);
  });

  it("breaks ties by virality then date", () => {
    const a = doc({ id: "a", caption: ["plant"], virality: 1, takenAt: 5 });
    const b = doc({ id: "b", caption: ["plant"], virality: 9, takenAt: 1 });
    const c = doc({ id: "c", caption: ["plant"], virality: 1, takenAt: 9 });
    expect(rankFind("plant", [a, b, c]).map((h) => h.id)).toEqual(["b", "c", "a"]);
  });

  it("returns nothing for an empty or stopword-only query", () => {
    expect(rankFind("", [caption])).toEqual([]);
    expect(rankFind("the and", [caption])).toEqual([]);
  });

  it("keeps a semantic-only hit when the text is nearly identical", () => {
    const text = "sleep training tips for toddlers who fight bedtime";
    const twin = doc({ id: "twin", vector: makeEmbedding(text).vector });
    const hits = rankFind(text, [twin, unrelated]);
    expect(hits.some((h) => h.id === "twin")).toBe(true);
  });

  it("does not keep semantic-only hits for a short topic word", () => {
    const lookalike = doc({
      id: "lookalike",
      caption: ["Sleep training tips"],
      vector: makeEmbedding("garden").vector,
    });
    const garden = doc({ id: "garden", caption: ["Early gardeners were months ahead"] });
    expect(rankFind("garden", [lookalike, garden, unrelated]).map((h) => h.id)).toEqual(["garden"]);
  });

  it("matches a longer form of the same word", () => {
    expect(termInSet(new Set(["gardener"]), "garden")).toBe(true);
    expect(termInSet(new Set(["sleep"]), "garden")).toBe(false);
  });

  it("does not treat a comment mention as a hit", () => {
    const onlyComments = doc({ id: "comments", comments: "they should garden more", virality: 1000 });
    const onScreen = doc({ id: "slides", slides: ["Early gardeners"] });
    expect(rankFind("garden", [onlyComments, onScreen]).map((h) => h.id)).toEqual(["slides"]);
  });

  it("ranks idea before on-screen before speech before caption", () => {
    const cap = doc({ id: "cap", caption: ["garden"], virality: 99 });
    const talk = doc({ id: "talk", transcript: "kids who garden", virality: 99 });
    const screen = doc({ id: "screen", slides: ["garden"], virality: 1 });
    const idea = doc({ id: "idea", idea: ["Gardening for kids"], virality: 1 });
    expect(rankFind("garden", [cap, talk, screen, idea]).map((h) => h.id)).toEqual(["idea", "screen", "talk", "cap"]);
  });

  it("finds 'risk' in 'Risky Play for Kids' first, and a post with both words beats one-word idea matches", () => {
    const risky = doc({ id: "risky", idea: ["Risky Play for Kids", "Let kids take risks"], caption: ["Why risky play matters"], virality: 1 });
    const playDates = doc({ id: "play-dates", idea: ["Play dates for toddlers"], virality: 500 });
    const playBox = doc({ id: "play-box", idea: ["Play with a cardboard box"], virality: 500 });
    const captionOnly = doc({ id: "caption-only", caption: ["risky play at the park"], virality: 1 });
    expect(rankFind("risk", [playDates, risky, playBox]).map((h) => h.id)).toEqual(["risky"]);
    const ids = rankFind("risky play", [playDates, playBox, captionOnly, risky]).map((h) => h.id);
    expect(ids.slice(0, 2)).toEqual(["risky", "caption-only"]);
    expect(ids.slice(2).sort()).toEqual(["play-box", "play-dates"]);
  });
});
