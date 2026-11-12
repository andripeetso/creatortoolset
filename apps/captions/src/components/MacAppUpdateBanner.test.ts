import { expect, it } from "vitest";
import { olderThan } from "./MacAppUpdateBanner";

it("compares Mac app versions as numbers", () => {
  expect(olderThan("0.9.1", "0.15.0")).toBe(true);
  expect(olderThan("0.15.0", "0.15.0")).toBe(false);
  expect(olderThan("0.16", "0.15.2")).toBe(false);
  expect(olderThan("1.0.0", "0.99.9")).toBe(false);
  expect(olderThan(undefined, "0.15.0")).toBe(true); // a Mac app from before it reported its version
  expect(olderThan(undefined, "0.0.0")).toBe(false);
  expect(olderThan("dev", "9.0.0")).toBe(false);
});
