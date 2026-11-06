import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECIPE,
  expandJobs,
  jobRecords,
  retryJobs,
  parseRecipe,
  parseRunWhen,
  recipeFromPreset,
  stampExistingPull,
  wants,
} from "./recipe";

describe("parseRecipe", () => {
  it("a save with no recipe makes the transcript and the on-screen text", () => {
    expect(parseRecipe(null).jobs).toEqual(["info", "stats", "media", "transcript", "vision"]);
    expect(DEFAULT_RECIPE.jobs).toEqual(["info", "stats", "media"]);
  });

  it("expands presets and custom checkboxes", () => {
    expect(recipeFromPreset("watch").jobs).toContain("media");
    expect(parseRecipe({ preset: "full" }).jobs).toContain("comments");
    expect(parseRecipe({ preset: "full" }).jobs).toContain("idea");
    expect(parseRecipe({ preset: "custom", jobs: ["vision", "tags"] }).jobs).toEqual([
      "info",
      "media",
      "vision",
      "tags",
    ]);
  });
});

describe("expandJobs", () => {
  it("pulls media in before transcript", () => {
    expect(expandJobs(["transcript"])).toEqual(["info", "media", "transcript"]);
  });

  it("always includes info and media, even for a comments-only run", () => {
    expect(expandJobs(["comments"])).toEqual(["info", "media", "comments"]);
    expect(expandJobs(["idea"])).toEqual(["info", "media", "idea"]);
    expect(expandJobs([])).toEqual(["info", "media"]);
  });
});

describe("jobRecords", () => {
  it("marks unrequested jobs idle", () => {
    const rows = jobRecords(recipeFromPreset("stats"), "pending");
    expect(rows.find((j) => j.type === "info")?.status).toBe("pending");
    expect(rows.find((j) => j.type === "media")?.status).toBe("pending");
    expect(rows.find((j) => j.type === "comments")?.status).toBe("idle");
    expect(wants(recipeFromPreset("stats"), "comments")).toBe(false);
  });
});

describe("parseRunWhen", () => {
  it("only treats later as deferred", () => {
    expect(parseRunWhen("later")).toBe("later");
    expect(parseRunWhen("now")).toBe("now");
    expect(parseRunWhen(undefined)).toBe("now");
  });
});

describe("stampExistingPull", () => {
  it("enqueues recipe jobs on a ready post and skips one already running", () => {
    const ready = { status: "ready" as const, jobs: jobRecords(DEFAULT_RECIPE, "done") };
    expect(stampExistingPull(ready, recipeFromPreset("watch"), "now")).toBe("enqueue");
    expect(ready.jobs.find((j) => j.type === "transcript")?.status).toBe("pending");
    const later: { status: "ready"; jobs?: ReturnType<typeof jobRecords> } = { status: "ready" };
    expect(stampExistingPull(later, recipeFromPreset("stats"), "later")).toBe("defer");
    expect(later.jobs?.find((j) => j.type === "stats")?.status).toBe("pending");
    expect(stampExistingPull({ status: "processing" }, DEFAULT_RECIPE, "now")).toBe("skip");
  });
});

describe("retryJobs", () => {
  it("re-runs a failed or waiting step that isn't in the recipe", () => {
    const jobs = [
      { type: "info" as const, status: "done" as const },
      { type: "idea" as const, status: "error" as const, error: "out of credits" },
      { type: "tags" as const, status: "pending" as const },
      { type: "comments" as const, status: "idle" as const },
    ];
    expect(retryJobs(recipeFromPreset("stats"), jobs)).toEqual(["info", "stats", "media", "tags", "idea"]);
    expect(retryJobs(undefined, [])).toEqual(["info", "stats", "media"]);
  });
});
