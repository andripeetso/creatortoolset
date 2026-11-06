import type { JobRecord, JobStatus, JobType, PostStatus, Recipe, RecipePreset } from "./types";

export const JOB_ORDER: JobType[] = [
  "info",
  "stats",
  "media",
  "transcript",
  "vision",
  "comments",
  "tags",
  "idea",
];

/** Media is always pulled: every recipe starts from info + stats + media. */
const PRESET_JOBS: Record<Exclude<RecipePreset, "custom">, JobType[]> = {
  stats: ["info", "stats", "media"],
  watch: ["info", "stats", "media", "transcript", "vision"],
  full: ["info", "stats", "media", "transcript", "vision", "comments", "tags", "idea"],
};

const DEPS: Record<JobType, JobType[]> = {
  info: [],
  stats: ["info"],
  media: ["info"],
  transcript: ["info", "media"],
  vision: ["info", "media"],
  comments: ["info"],
  tags: ["info"],
  idea: ["info"],
};

export function jobsForPreset(preset: RecipePreset): JobType[] {
  if (preset === "custom") return [...PRESET_JOBS.stats];
  return [...PRESET_JOBS[preset]];
}

export function recipeFromPreset(preset: RecipePreset): Recipe {
  return { preset, jobs: jobsForPreset(preset) };
}

export const DEFAULT_RECIPE = recipeFromPreset("stats");
/** What a save runs when it names no recipe: the transcript and the on-screen text come with every post. */
export const SAVE_RECIPE = recipeFromPreset("watch");

function isJobType(j: unknown): j is JobType {
  return JOB_ORDER.includes(j as JobType);
}

export function parseRecipe(raw: unknown): Recipe {
  if (!raw || typeof raw !== "object") return { ...SAVE_RECIPE };
  const rec = raw as { preset?: unknown; jobs?: unknown };
  const preset: RecipePreset =
    rec.preset === "stats" || rec.preset === "watch" || rec.preset === "full" || rec.preset === "custom"
      ? rec.preset
      : "custom";
  if (preset !== "custom") return recipeFromPreset(preset);
  const jobs = Array.isArray(rec.jobs)
    ? expandJobs(rec.jobs.filter(isJobType))
    : jobsForPreset("stats");
  return { preset: "custom", jobs: jobs.length ? jobs : jobsForPreset("stats") };
}

export function parseRunWhen(raw: unknown): "now" | "later" {
  return raw === "later" ? "later" : "now";
}

/**
 * Expand requested jobs with dependencies, in pipeline order. Info and
 * media are always included: the library never holds a post without its
 * slides on disk.
 */
export function expandJobs(requested: JobType[]): JobType[] {
  const set = new Set<JobType>(["info", "media"]);
  for (const job of requested) {
    for (const dep of DEPS[job] ?? []) set.add(dep);
    set.add(job);
  }
  return JOB_ORDER.filter((j) => set.has(j));
}

export function wants(recipe: Recipe | undefined, job: JobType): boolean {
  return (recipe?.jobs ?? DEFAULT_RECIPE.jobs).includes(job);
}

export function jobRecords(recipe: Recipe, status: JobStatus = "pending"): JobRecord[] {
  const wanted = new Set(expandJobs(recipe.jobs));
  return JOB_ORDER.map((type) => ({
    type,
    status: wanted.has(type) ? status : "idle",
  }));
}

export function patchJob(
  jobs: JobRecord[] | undefined,
  type: JobType,
  patch: Partial<JobRecord>,
): JobRecord[] {
  const list = jobs?.length ? jobs.map((j) => ({ ...j })) : jobRecords(DEFAULT_RECIPE, "idle");
  const i = list.findIndex((j) => j.type === type);
  const now = Date.now();
  const base: JobRecord = i >= 0 ? list[i] : { type, status: "idle" };
  const next: JobRecord = { ...base, ...patch };
  if (patch.status === "running" && !next.startedAt) next.startedAt = now;
  if (patch.status === "done" || patch.status === "error" || patch.status === "skipped") {
    next.finishedAt = now;
  }
  if (i >= 0) list[i] = next;
  else list.push(next);
  return list;
}

export function jobStatusOf(jobs: JobRecord[] | undefined, type: JobType): JobStatus {
  return jobs?.find((j) => j.type === type)?.status ?? "idle";
}

export function isJobDone(jobs: JobRecord[] | undefined, type: JobType): boolean {
  const s = jobStatusOf(jobs, type);
  return s === "done" || s === "skipped";
}

/** What Retry runs: the recipe plus any step that failed or never ran
 *  (an Idea that hit "out of credits" isn't in the recipe, so it stayed failed). */
export function retryJobs(recipe: Recipe | undefined, jobs: JobRecord[] | undefined): JobType[] {
  const open = (jobs ?? []).filter((j) => j.status === "error" || j.status === "pending").map((j) => j.type);
  return expandJobs([...(recipe?.jobs ?? ["info", "stats"]), ...open]);
}

/** Catalog pull of a post already in the library: enqueue recipe jobs instead of no-op. */
export function stampExistingPull(
  meta: { status: PostStatus; recipe?: Recipe; jobs?: JobRecord[] },
  recipe: Recipe,
  run: "now" | "later",
): "enqueue" | "defer" | "skip" {
  if (meta.status === "processing") return "skip";
  meta.recipe = recipe;
  if (run === "later") {
    meta.jobs = jobRecords(recipe, "pending");
    return "defer";
  }
  for (const t of expandJobs(recipe.jobs)) {
    meta.jobs = patchJob(meta.jobs, t, { status: "pending" });
  }
  return "enqueue";
}
