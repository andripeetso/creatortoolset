import { useEffect } from "react";
import { create } from "zustand";
import { planWarning, type Feature, type PlanId } from "@contracts/plans";
import { DEFAULT_TOOLS, type SetupView, type Tool } from "@contracts/tools";
import { DEFAULT_WORK_PREFS, type Make, type WorkPrefs } from "@contracts/work-prefs";
import { confirmDialog } from "./dialogs";

export type { SetupView };

/** The five steps, the same on every path. The progress bar counts the last four (from step 2): "n of 4", never changing. */
export const SETUP_STEPS = ["how", "make", "project", "ai", "done"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** Ids from the older, longer setup still open the step they now belong to. */
const OLD_STEP: Record<string, SetupStep> = { tools: "make", connect: "ai", left: "done" };

/** The `?setup=` value as a step, or null when it names none (then setup opens on its first step). */
export function setupStepFromParam(v: string | null): SetupStep | null {
  if (!v) return null;
  const id = Object.hasOwn(OLD_STEP, v) ? OLD_STEP[v]! : v;
  return (SETUP_STEPS as readonly string[]).includes(id) ? (id as SetupStep) : null;
}

/** Setup is finished once Done saved `done` on its last step, and that run picked tools (leaving step 2 saves them). */
export const setupFinished = (view: Pick<SetupView, "done" | "tools">): boolean => view.done && view.tools !== null;

/**
 * Storage can be missing or throw (a private window, blocked site data): every read and write goes through here, and
 * the fallbacks keep setup working for this page load.
 */
const store = (kind: "session" | "local"): Storage | undefined => {
  try {
    return globalThis[kind === "session" ? "sessionStorage" : "localStorage"];
  } catch {
    return undefined;
  }
};
const read = (kind: "session" | "local", key: string): string | null => {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
};
const write = (kind: "session" | "local", key: string, value: string) => {
  try {
    store(kind)?.setItem(key, value);
  } catch {
    /* no storage: the in-memory flag below still holds for this page load */
  }
};

const DISMISSED = "ct-setup-dismissed";
const LATER = "ct-setup-later";
let dismissedThisLoad = false;

/** Not now and Done: setup stops opening by itself in this browser; Home keeps the way back. */
export function dismissSetup(): void {
  dismissedThisLoad = true;
  write("local", DISMISSED, "1");
}
export const setupDismissed = (): boolean => dismissedThisLoad || read("local", DISMISSED) === "1";

/**
 * Whether the setup window is up: asked for by `?setup=` (Home's card, Settings, the first run), or the account isn't
 * finished and Not now wasn't pressed. Home's "Finish setting up" card hides while it is, and the assistant dock and
 * the selection popup stay away from it.
 */
export const setupOpen = (view: Pick<SetupView, "done" | "tools"> | null, asked: string | null): boolean =>
  !!view && (asked !== null || (!setupFinished(view) && !setupDismissed()));

/** Remembers the step Not now was pressed on, for Finish setting up. */
export function rememberLater(step: SetupStep): void {
  write("session", LATER, step);
}

/** Where Finish setting up reopens: the step Not now was pressed on, else the first. */
export function resumeStep(): SetupStep {
  return setupStepFromParam(read("session", LATER)) ?? "how";
}

/** Opens setup at a step from anywhere (Home, Settings): sets `?setup=` and tells the router the address changed. */
export function openSetupAt(step: SetupStep): void {
  const url = new URL(window.location.href);
  url.searchParams.set("setup", step);
  window.history.pushState(window.history.state, "", url);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

/** The tool a page belongs to, by its path (App.tsx's routes), for the first-open checklist. */
export function toolForPath(p: string): Tool | null {
  const first = p.split("/")[1] ?? "";
  const by: Record<string, Tool> = {
    instagram: "instagram", analyzer: "instagram", workshop: "workshop", enhance: "enhance", captions: "captions", review: "review",
    library: "media", editor: "editor", clean: "clean", stories: "stories", clips: "notes", "video-notes": "notes", documents: "guides", guides: "guides",
  };
  return by[first] ?? null;
}

async function json<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as T;
}

export interface SetupPatch {
  tools?: Tool[];
  plan?: PlanId | null;
  done?: boolean;
}

/** The account's setup (api/setup.ts), shared by the dialog, the first-open checklist, Settings → Setup and the plan warnings. */
export const useSetup = create<{ view: SetupView | null; load: () => Promise<SetupView | null>; save: (p: SetupPatch) => Promise<void> }>((set) => ({
  view: null,
  load: () =>
    fetch("/api/setup")
      .then((r) => json<SetupView>(r))
      .then((view) => (set({ view }), view))
      .catch(() => null), // a guest or the demo has none
  save: (p) =>
    fetch("/api/setup", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) })
      .then((r) => json<SetupView>(r))
      .then((view) => set({ view })),
}));

/** Reads the setup again every few seconds while `on`, and when the window comes back to the front: a key added in another form shows up. */
export function useSetupLive(on: boolean) {
  const load = useSetup((s) => s.load);
  useEffect(() => {
    if (!on) return;
    void load();
    const t = window.setInterval(() => void load(), 5000);
    const again = () => void load();
    window.addEventListener("focus", again);
    return () => (window.clearInterval(t), window.removeEventListener("focus", again));
  }, [on, load]);
}

/** Opens a tool's checklist from anywhere (a tool's own "Set up" link); FirstOpen listens. */
export const openToolSetup = (tool: Tool) => window.dispatchEvent(new CustomEvent("ct-tool-setup", { detail: tool }));

/** The account's work preferences (api/work-prefs.ts), shared by setup's steps and useWorkTalk. */
interface WorkPrefsState {
  prefs: WorkPrefs | null;
  load: () => Promise<void>;
  put: (p: Partial<WorkPrefs>) => Promise<void>;
}
export const useWorkPrefs = create<WorkPrefsState>((set, get) => ({
  prefs: null,
  load: () =>
    fetch("/api/work-prefs")
      .then((r) => (r.ok ? (r.json() as Promise<WorkPrefs>) : DEFAULT_WORK_PREFS))
      .then((prefs) => set({ prefs }))
      .catch(() => {}),
  put: (p) => {
    const cur = get().prefs;
    if (cur) set({ prefs: { ...cur, ...p } }); // shown at once; the server's copy replaces it below
    return fetch("/api/work-prefs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) })
      .then((r) => (r.ok ? (r.json() as Promise<WorkPrefs>) : null))
      .then((w) => {
        if (w) set({ prefs: w });
      })
      .catch(() => {});
  },
}));

/** How they want to work with the AI (work-prefs `talk`), loaded on first use. `talk` is null until the server answers. */
export function useWorkTalk(): { talk: WorkPrefs["talk"] | null; setTalk: (v: WorkPrefs["talk"]) => Promise<void> } {
  const prefs = useWorkPrefs((s) => s.prefs);
  const load = useWorkPrefs((s) => s.load);
  useEffect(() => {
    if (!prefs) void load();
  }, [prefs, load]);
  return { talk: prefs?.talk ?? null, setTalk: (v) => useWorkPrefs.getState().put({ talk: v }) };
}

/**
 * Before a heavy AI run: on a Pro or Plus plan, says how much of the 5-hour window it usually takes and asks first.
 * True = go ahead (no plan given, a bigger plan, a light run, or they said so).
 */
export async function confirmHeavy(feature: Feature, count = 1): Promise<boolean> {
  const view = useSetup.getState().view ?? (await useSetup.getState().load());
  const warning = planWarning(view?.plan, feature, count);
  if (!warning) return true;
  return confirmDialog({ title: "This can use up your plan's limit", body: warning, ok: "Run it anyway" });
}

/** "What will you make?": each answer, the words setup shows for it. */
export const MAKE_NAMES: Record<Make, string> = {
  reel: "Short videos",
  youtube: "Long videos (YouTube)",
  carousel: "Carousels, image posts",
  ad: "Ads",
  podcast: "Podcasts and audio",
  course: "Courses and guides",
  recording: "Screen recordings",
  newsletter: "Newsletters and email",
  thread: "X posts and threads",
  article: "Articles and blogs",
  other: "Something else",
};

/**
 * The one extra each answer switches on, and only when it clearly fits. Video Cleaner and Story Splitter are never
 * switched on by an answer (they stay off until picked), and an answer with no fit adds nothing.
 */
const MAKE_EXTRA: Partial<Record<Make, Tool>> = { reel: "captions", podcast: "enhance", course: "guides", recording: "notes" };

/**
 * The tools "What will you make?" ticks, in `mine`'s order: the default tools (always on, DEFAULT_TOOLS) plus the extra
 * each answer fits. Not sure yet picks everything instead (the dialog does that itself).
 */
export const toolsFor = (makes: readonly Make[], mine: readonly Tool[]): Tool[] => {
  const want = new Set<Tool>([...DEFAULT_TOOLS, ...makes.flatMap((m) => (MAKE_EXTRA[m] ? [MAKE_EXTRA[m]!] : []))]);
  return mine.filter((t) => want.has(t));
};
