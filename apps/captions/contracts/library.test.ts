import { describe, expect, it } from "vitest";
import { applyS3Preset, S3_PRESETS } from "./library";

describe("S3 presets", () => {
  const form = { endpoint: "", region: "", bucket: "tiny-acrobatics-footage", pathStyle: false, accessKey: "k", secretKey: "s" };

  it("ships the four templates", () => {
    expect(S3_PRESETS.map((p) => p.id)).toEqual(["r2", "b2", "wasabi", "minio"]);
  });

  it("Backblaze B2 and Wasabi fill their endpoint, region and path-style", () => {
    expect(applyS3Preset(form, "b2")).toMatchObject({ endpoint: "https://s3.us-west-004.backblazeb2.com", region: "us-west-004", pathStyle: true });
    expect(applyS3Preset(form, "wasabi")).toMatchObject({ endpoint: "https://s3.us-east-1.wasabisys.com", region: "us-east-1", pathStyle: true });
  });

  it("R2 and MinIO leave the endpoint empty for the owner to type, with a placeholder hint, never <…> text", () => {
    for (const id of ["r2", "minio"] as const) {
      expect(applyS3Preset(form, id)).toMatchObject({ endpoint: "", region: id === "r2" ? "auto" : "us-east-1", pathStyle: true });
      const hint = S3_PRESETS.find((p) => p.id === id)!.endpointHint;
      expect(hint).toMatch(/^https:\/\//);
    }
    expect(S3_PRESETS.every((p) => !/[<>]/.test(p.endpoint))).toBe(true);
  });

  it("R2 and MinIO keep an endpoint the owner already typed", () => {
    expect(applyS3Preset({ ...form, endpoint: "https://abc.r2.cloudflarestorage.com" }, "r2").endpoint).toBe("https://abc.r2.cloudflarestorage.com");
  });

  it("keeps the bucket and the keys", () => {
    expect(applyS3Preset(form, "b2")).toMatchObject({ bucket: "tiny-acrobatics-footage", accessKey: "k", secretKey: "s" });
  });
});
