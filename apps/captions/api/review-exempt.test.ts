import { describe, expect, it } from "vitest";
import { PUBLIC_REVIEW, REVIEW_UPLOAD, UPLOAD_RELAY } from "./boot";

// Golden: which Review paths skip the login. Changing these regexes must change this list on purpose.
const U = "3f2b9c1e-8a7d-4c6b-9e10-2d4f5a6b7c8d";

describe("Review login exemptions", () => {
  it("share links for a video (/s/) and a project (/p/) are public", () => {
    expect(PUBLIC_REVIEW.test(`/api/review/s/${U}`)).toBe(true);
    expect(PUBLIC_REVIEW.test(`/api/review/p/${U}/comments`)).toBe(true);
    expect(PUBLIC_REVIEW.test(`/api/review/assets/${U}`)).toBe(false);
    expect(PUBLIC_REVIEW.test("/api/review/s/not-a-uuid")).toBe(false);
  });

  it("only the upload start, parts and complete are public", () => {
    expect(REVIEW_UPLOAD.test("/api/review/uploads")).toBe(true);
    expect(REVIEW_UPLOAD.test(`/api/review/uploads/${U}/parts/3`)).toBe(true);
    expect(REVIEW_UPLOAD.test(`/api/review/uploads/${U}/complete`)).toBe(true);
    expect(REVIEW_UPLOAD.test(`/api/review/uploads/${U}`)).toBe(false);
    expect(REVIEW_UPLOAD.test("/api/review/uploads/relay")).toBe(false);
  });

  it("/api/uploads/relay and /api/uploads/known are not exempt in either regex", () => {
    for (const p of ["/api/uploads/relay", "/api/uploads/known"]) {
      expect(PUBLIC_REVIEW.test(p)).toBe(false);
      expect(REVIEW_UPLOAD.test(p)).toBe(false);
    }
  });

  // Critic B8: the relay answers the same as Review's upload routes, path for path (only the prefix differs)
  it("the relay routes are exactly the Review upload routes under /api/uploads/relay", () => {
    const paths = [
      "/api/uploads",
      "/api/uploads/relay",
      `/api/uploads/relay/${U}`,
      `/api/uploads/relay/${U}/parts/3`,
      `/api/uploads/relay/${U}/complete`,
      `/api/uploads/relay/${U}/parts/x`,
      "/api/uploads/relay/relay",
      `/api/uploads/relay/${U}/status`,
    ];
    for (const p of paths) {
      const review = p.replace("/api/uploads/relay", "/api/review/uploads");
      expect(UPLOAD_RELAY.test(p), p).toBe(REVIEW_UPLOAD.test(review));
      expect(PUBLIC_REVIEW.test(p), p).toBe(false);
    }
  });
});
