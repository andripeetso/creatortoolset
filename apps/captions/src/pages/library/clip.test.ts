import { describe, expect, it } from "vitest";
import type { AssetCard, AssetDetail, ShareRow } from "@contracts/library";
import { copyReady, daysLeft, factsOf, linksOf, original, playerNote } from "./clip";

const card: AssetCard = { id: "a1", libraryId: "l1", kind: "video", title: "Tiny Acrobatics jump", versionId: "v1", versionN: 1, tags: [], aiTags: [], state: "ready" };
const detail = (jobs: AssetDetail["jobs"], more: Partial<AssetDetail> = {}): AssetDetail => ({ ...card, versions: [], collections: [], jobs, ...more });

describe("the clip panel's player", () => {
  it("says a lighter copy is on its way while the probe or the copy is queued or running", () => {
    expect(playerNote("ready", detail([{ kind: "probe", state: "done" }, { kind: "proxy", state: "running" }]))).toBe("preparing");
    expect(playerNote("processing", detail([{ kind: "probe", state: "queued" }]))).toBe("preparing");
    // just uploaded: nothing has looked at the file yet
    expect(playerNote("processing", detail([], { state: "processing" }))).toBe("preparing");
  });

  it("says the file does not play here when no copy is coming, and that the original is gone when it is", () => {
    expect(playerNote("ready", detail([{ kind: "probe", state: "done" }]))).toBe("unplayable");
    expect(playerNote("ready", detail([{ kind: "probe", state: "done" }, { kind: "proxy", state: "failed" }]))).toBe("unplayable");
    expect(playerNote("missing", null)).toBe("missing");
    expect(playerNote("ready", null)).toBe("unknown");
  });

  it("tries again once the copy is made", () => {
    expect(copyReady(detail([{ kind: "proxy", state: "done" }]))).toBe(true);
    expect(copyReady(detail([{ kind: "proxy", state: "running" }]))).toBe(false);
    expect(copyReady(null)).toBe(false);
  });

  it("saves the original under its title, with the file's extension when its path is known", () => {
    expect(original(card, null)).toEqual({ href: "/api/library/media/v1/source", name: "Tiny Acrobatics jump" });
    expect(original(card, detail([], { sourcePath: "/Volumes/Cam/C0001.MP4" })).name).toBe("Tiny Acrobatics jump.MP4");
  });
});

describe("the clip panel's facts and share links", () => {
  it("lists the day it was filmed, length, size and roll, and a version only past the first", () => {
    const filmed = new Date(2026, 10, 3).getTime();
    const facts = factsOf({ ...card, durationS: 74, width: 3840, height: 2160, roll: "b", capturedAt: filmed });
    expect(facts.map(([label]) => label)).toEqual(["Filmed", "Length", "Size", "Roll"]);
    expect(facts.slice(1)).toEqual([["Length", "1:14"], ["Size", "3840×2160"], ["Roll", "B-roll"]]);
    expect(factsOf({ ...card, roll: "a", versionN: 2 })).toEqual([["Roll", "A-roll"], ["Version", "2"]]);
  });

  it("counts a link's days left up, never below one", () => {
    const now = 1_000_000;
    expect(daysLeft(now + 7 * 86_400_000, now)).toBe(7);
    expect(daysLeft(now + 6.2 * 86_400_000, now)).toBe(7);
    expect(daysLeft(now + 1000, now)).toBe(1);
  });

  it("keeps the library's links that open this clip", () => {
    const row = (id: string, kind: ShareRow["target"]["kind"], target: string): ShareRow => ({
      id,
      target: { kind, id: target },
      scope: "view",
      locked: false,
      createdBy: "admin",
      expiresAt: 0,
      views: 0,
    });
    const all = [row("s1", "asset", "a1"), row("s2", "asset", "a2"), row("s3", "version", "v1"), row("s4", "collection", "a1")];
    expect(linksOf(all, "a1", "v1").map((s) => s.id)).toEqual(["s1", "s3"]);
  });
});
