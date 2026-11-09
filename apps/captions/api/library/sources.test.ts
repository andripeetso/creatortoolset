import { afterEach, describe, expect, it } from "vitest";
import type { LibraryAssetRef, LibraryViewer } from "../../contracts/library-source";
import { assetRef, canSee, facetClauses, LIBRARY_SOURCE, registerLibrarySlot, resetLibrarySlots } from "./sources";

afterEach(() => resetLibrarySlots());

const owner: LibraryViewer = { username: "owner-a", role: "owner" };
const member: LibraryViewer = { username: "member-b", role: "member" };
const asset: LibraryAssetRef = assetRef("lib_a", "pub-1", "pub-1-v1");

describe("library policy", () => {
  it("the built-in library is owner-only: a member sees nothing by default", async () => {
    expect(await canSee(owner, asset)).toBe(true);
    expect(await canSee(member, asset)).toBe(false);
  });

  it("a source with no policy refuses every viewer", async () => {
    expect(await canSee(owner, { ...asset, sourceId: "ghost" })).toBe(false);
  });

  it("a plug-in policy can only narrow: a member still cannot see, and an owner loses what the plug-in refuses", async () => {
    registerLibrarySlot("test", {
      policies: [{ sourceId: LIBRARY_SOURCE, canSee: (_v, a) => a.assetId !== "pub-1" }],
    });
    expect(await canSee(owner, asset)).toBe(false);
    expect(await canSee(owner, { ...asset, assetId: "pub-2" })).toBe(true);
    expect(await canSee(member, { ...asset, assetId: "pub-2" })).toBe(false);
  });

  it("a plug-in policy cannot widen: a policy that says yes does not let a member in", async () => {
    registerLibrarySlot("test", { policies: [{ sourceId: LIBRARY_SOURCE, canSee: () => true }] });
    expect(await canSee(member, asset)).toBe(false);
  });

  it("a policy that throws counts as no", async () => {
    registerLibrarySlot("test", {
      policies: [{ sourceId: LIBRARY_SOURCE, canSee: () => { throw new Error("broken plug-in"); } }],
    });
    expect(await canSee(owner, asset)).toBe(false);
  });

  it("a plug-in source needs its own policy, and a policy for an unknown source is refused at registration", async () => {
    registerLibrarySlot("test", { source: { id: "catalog", label: "Catalog" } });
    expect(await canSee(owner, { ...asset, sourceId: "catalog" })).toBe(false);
    expect(() => registerLibrarySlot("test", { policies: [{ sourceId: "nope", canSee: () => true }] })).toThrow(/unknown source/);
    expect(() => registerLibrarySlot("test", { source: { id: "catalog", label: "again" } })).toThrow(/already registered/);
  });
});

describe("library facets", () => {
  it("a plug-in facet narrows by its own SQL, and an unknown key or an empty pick adds nothing", () => {
    registerLibrarySlot("test", {
      facets: [{ key: "safety", where: (vals) => ({ sql: `a.title IN (${vals.map(() => "?").join(",")})`, params: vals }) }],
    });
    expect(facetClauses({ safety: ["Finals reel", "Roll"] })).toEqual([{ sql: "a.title IN (?,?)", params: ["Finals reel", "Roll"] }]);
    expect(facetClauses({ nope: ["x"], safety: [] })).toEqual([]);
  });

  it("a second plug-in cannot take a facet key the first one has", () => {
    const facet = { key: "safety", where: () => ({ sql: "1", params: [] }) };
    registerLibrarySlot("one", { facets: [facet] });
    expect(() => registerLibrarySlot("two", { facets: [facet] })).toThrow(/already registered/);
  });
});
