import { describe, expect, it } from "vitest";
import { reviewListing } from "./ReviewPage";

type A = Parameters<typeof reviewListing>[0] extends (infer L)[] | null ? L : never;
type P = Parameters<typeof reviewListing>[1][number];
const project = (id: string, name: string, createdAt: number): P => ({ id, name, createdAt });
const video = (id: string, name: string, updatedAt: number, projectId?: string, finished = false): A =>
  ({ id, name, projectId, createdAt: 0, updatedAt, versions: [], approval: { status: "none" }, done: finished ? { finished, at: 1 } : undefined }) as unknown as A;

// The server sends videos newest activity first: the fixtures are in that order.
const projects = [project("old", "Bath time tips", 1), project("new", "Rolling practice", 5), project("empty", "Attic", 9)];
const assets = [
  video("v1", "Crawl loose", 90),
  video("v2", "Bath clip", 80, "old"),
  video("v3", "Roll A", 70, "new", true),
  video("v4", "Roll B", 60, "new"),
  video("v5", "Zebra loose", 50),
  video("v6", "Done loose", 40, undefined, true),
  video("v7", "Orphan", 30, "gone"),
];
const names = (r: ReturnType<typeof reviewListing>) => [...r.projects.map((p) => `[${p.name}]`), ...(r.videos ?? []).map((v) => v.name)];

describe("Review's folders view listing", () => {
  it("Recent: projects by their newest video (an empty one by when it was made), then the loose videos as the server sent them", () => {
    expect(names(reviewListing(assets, projects, { done: false, q: "", sort: "recent" }))).toEqual([
      "[Bath time tips]", // newest video 80
      "[Rolling practice]", // newest video 70
      "[Attic]", // nothing inside: when it was made (9), and in progress
      "Crawl loose",
      "Zebra loose",
      "Orphan", // its project is gone: at the top level
    ]);
  });

  it("Name: A to Z, projects first", () => {
    expect(names(reviewListing(assets, projects, { done: false, q: "", sort: "name" }))).toEqual([
      "[Attic]",
      "[Bath time tips]",
      "[Rolling practice]",
      "Crawl loose",
      "Orphan",
      "Zebra loose",
    ]);
  });

  it("Finished: a finished loose video; a project only once every video in it is finished", () => {
    expect(names(reviewListing(assets, projects, { done: true, q: "", sort: "recent" }))).toEqual(["Done loose"]);
  });

  it("inside a project: its videos only, the finished ones last", () => {
    expect(names(reviewListing(assets, projects, { project: "new", done: false, q: "", sort: "recent" }))).toEqual(["Roll B", "Roll A"]);
  });

  it("a search at the top level finds videos inside projects too, and projects by name", () => {
    expect(names(reviewListing(assets, projects, { done: false, q: "bath", sort: "recent" }))).toEqual(["[Bath time tips]", "Bath clip"]);
    expect(names(reviewListing(assets, projects, { done: false, q: "roll", sort: "recent" }))).toEqual(["[Rolling practice]", "Roll B"]);
  });

  it("before the list is known there are no videos to show", () => {
    expect(reviewListing(null, projects, { done: false, q: "", sort: "recent" }).videos).toBeNull();
  });
});
