import { describe, expect, it } from "vitest";
import { applyS3Preset, S3_PRESETS } from "./library";

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
