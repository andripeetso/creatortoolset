import { describe, expect, it } from "vitest";
import { ANALYSIS_LEVELS, applyS3Preset, flagsOf, hostsOriginals, hostsProxies, levelOf, organizeOf, S3_PRESETS, uploadFrom, type LibraryUpload } from "./library";

describe("S3 presets", () => {
  const form = { endpoint: "", region: "", bucket: "tiny-acrobatics-footage", pathStyle: false, accessKey: "k", secretKey: "s" };

  it("ships Amazon S3 and Cloudflare R2", () => {
    expect(S3_PRESETS.map((p) => p.id)).toEqual(["aws", "r2"]);
  });

  it("Amazon S3 clears the endpoint (the SDK finds it by region) and uses virtual-hosted URLs", () => {
    expect(applyS3Preset({ ...form, endpoint: "https://s3.example.com", pathStyle: true }, "aws")).toMatchObject({ endpoint: "", region: "us-east-1", pathStyle: false });
  });

  it("R2 leaves the endpoint for the owner to type, with a placeholder hint, and keeps one already typed", () => {
    expect(applyS3Preset(form, "r2")).toMatchObject({ endpoint: "", region: "auto", pathStyle: true });
    expect(S3_PRESETS.find((p) => p.id === "r2")!.endpointHint).toMatch(/^https:\/\//);
    expect(applyS3Preset({ ...form, endpoint: "https://abc.r2.cloudflarestorage.com" }, "r2").endpoint).toBe("https://abc.r2.cloudflarestorage.com");
  });

  it("keeps the bucket and the keys", () => {
    expect(applyS3Preset(form, "r2")).toMatchObject({ bucket: "tiny-acrobatics-footage", accessKey: "k", secretKey: "s" });
  });
});

describe("Analysis effort (UNIFIED-PRD §4.4)", () => {
  it("flagsOf writes the table", () => {
    const row = (l: Parameters<typeof flagsOf>[0]) => {
      const f = flagsOf(l);
      return [f.transcribe, f.describe, f.embed, f.pictures, f.look && f.lookLevel, f.timeline, f.lookTalking];
    };
    expect(row("off")).toEqual([false, false, false, false, false, false, false]);
    expect(row("low")).toEqual([true, true, true, true, false, false, false]);
    expect(row("medium")).toEqual([true, true, true, true, "light", false, false]);
    expect(row("high")).toEqual([true, true, true, true, "standard", true, false]);
    expect(row("xhigh")).toEqual([true, true, true, true, "detailed", true, false]);
    expect(row("max")).toEqual([true, true, true, true, "detailed", true, true]);
  });
  it("levelOf(flagsOf(l)) round-trips every level", () => {
    for (const { value } of ANALYSIS_LEVELS) expect(levelOf(flagsOf(value))).toBe(value);
  });
  it("today's default flags (all on, standard, transcribe absent) read as High", () => {
    expect(levelOf({ describe: true, embed: true, pictures: true, look: true, lookLevel: "standard", timeline: true })).toBe("high");
  });
  it("flags that fit no level show the lowest level covering them", () => {
    expect(levelOf({ describe: false, embed: false, look: false, timeline: true, transcribe: false })).toBe("high");
    expect(levelOf({ describe: false, embed: false, look: false, timeline: false })).toBe("low"); // transcribe absent = on
  });
});

describe("Hosted media and Organization helpers", () => {
  it("hostsOriginals / hostsProxies / uploadFrom", () => {
    const all: LibraryUpload[] = ["none", "originals", "proxies", "all"];
    expect(all.map((u) => [hostsOriginals(u), hostsProxies(u)])).toEqual([[false, false], [true, false], [false, true], [true, true]]);
    for (const u of all) expect(uploadFrom(hostsOriginals(u), hostsProxies(u))).toBe(u);
  });
  it('organizeOf reads a stored "default" as own', () => {
    expect(organizeOf("default")).toBe("own");
    expect([organizeOf("ai"), organizeOf("own"), organizeOf(undefined)]).toEqual(["ai", "own", undefined]);
  });
});
