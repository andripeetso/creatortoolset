import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { cookieSiteWrites, ownFailure, readOnlyFor } from "./boot";
import { env } from "./lib/env";
import type { SessionUser, Tool } from "./users";

describe("ownFailure", () => {
  it("sends the app's own 502 and 504 as 500, which a proxy passes on with the message", () => {
    expect([502, 504].map(ownFailure)).toEqual([500, 500]);
    expect([200, 402, 500, 503].map(ownFailure)).toEqual([200, 402, 500, 503]);
  });
});

const account = (read?: Tool[]): SessionUser => ({ username: "ana", role: "user", cloud: true, off: [], read });

describe("readOnlyFor: an app set to Read refuses writes, AI keys included", () => {
  it("refuses a Review upload from an account that has Review on Read", () => {
    expect(readOnlyFor(account(["review"]), "POST", "/api/review/uploads")).toBe("review");
    expect(readOnlyFor(account(["review"]), "GET", "/api/review/uploads")).toBeNull();
  });

  it("refuses a Caption Studio export write, and not one from an account with Caption Studio on", () => {
    expect(readOnlyFor(account(["captions"]), "POST", "/api/exports")).toBe("captions");
    expect(readOnlyFor(account(["captions"]), "POST", "/api/exports/abc/library")).toBe("captions");
    expect(readOnlyFor(account(), "POST", "/api/exports")).toBeNull();
  });
});

describe("COOKIE_DOMAIN: a write from another site is refused on every route", () => {
  const probe = new Hono();
  probe.use("/api/*", cookieSiteWrites);
  probe.post("/api/anything", (c) => c.text("ok"));
  const post = (headers: Record<string, string>) =>
    probe.request("http://app.example.com/api/anything", { method: "POST", headers });

  it("refuses a cookie write from a sibling subdomain only when COOKIE_DOMAIN is set", async () => {
    const before = env.cookieDomain;
    try {
      env.cookieDomain = ".example.com";
      expect((await post({ origin: "https://other.example.com", "content-type": "text/plain" })).status).toBe(403);
      expect((await post({ origin: "https://app.example.com", "content-type": "text/plain" })).status).toBe(200);
      // a bearer key is no browser's
      expect((await post({ origin: "https://other.example.com", authorization: "Bearer x" })).status).toBe(200);
      env.cookieDomain = "";
      expect((await post({ origin: "https://other.example.com", "content-type": "text/plain" })).status).toBe(200);
    } finally {
      env.cookieDomain = before;
    }
  });
});
