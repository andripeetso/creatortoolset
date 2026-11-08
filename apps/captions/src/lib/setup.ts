import { useEffect } from "react";
import { create } from "zustand";
import { planWarning, type Feature, type PlanId } from "@contracts/plans";
import { usesAi, type SetupView, type Tool } from "@contracts/tools";
import type { Make, WorkPrefs } from "@contracts/work-prefs";
import { confirmDialog } from "./dialogs";

export type { SetupView };

/** The first-run steps, in order. */
export type SetupStep = "how" | "make" | "tools" | "project" | "ai" | "connect" | "left";

/**
 * Which steps show. "How do you want to use Creator Toolset?" first; its answer (work-prefs `talk`) decides the rest.
 * In the app: what they make, tools, the first project only for the Workshop or the Analyzer, the AI only when a ticked tool uses it.
 * In my own AI: connect it, nothing else. Both: the app's steps, then connect. What's left always.
 */
export function setupSteps(ticked: readonly Tool[], talk: WorkPrefs["talk"]): SetupStep[] {
  if (talk === "chat") return ["how", "connect", "left"];
  return [
    "how",
    "make",
    "tools",
    ...(ticked.includes("workshop") || ticked.includes("instagram") ? (["project"] as const) : []),
    ...(ticked.some(usesAi) ? (["ai"] as const) : []),
    ...(talk === "both" ? (["connect"] as const) : []),
    "left",
  ];
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

/** The account's setup (api/setup.ts), shared by the dialog, the first-open checklist, Settings → Setup and the plan warnings. */
export const useSetup = create<{ view: SetupView | null; load: () => Promise<SetupView | null>; save: (p: { tools?: Tool[]; plan?: PlanId | null; done?: boolean }) => Promise<void> }>((set) => ({
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
  reel: "Short videos (Reels, TikTok, Shorts)",
  youtube: "Long videos (YouTube)",
  carousel: "Carousels and image posts",
  ad: "Ads",
  podcast: "Podcasts and audio",
  course: "Courses, guides and SOPs",
  recording: "Screen recordings and walkthroughs",
  newsletter: "Newsletters and emails",
  thread: "X posts and threads",
  article: "Articles and blog posts",
  other: "Something else",
};

/**
 * What each answer ticks (the Workshop always). Footage tools (Media Library, AI Editor) only for video and pictures, so
 * someone who only writes is never asked for a library; Review for anything someone else checks before it goes out.
 */
const VIDEO: Tool[] = ["media", "editor", "review", "captions", "enhance", "clean"];
const MAKE_TOOLS: Record<Make, Tool[]> = {
  reel: [...VIDEO, "instagram", "stories"],
  youtube: [...VIDEO, "instagram", "notes"],
  carousel: ["instagram", "media", "review", "clean"],
  ad: ["media", "editor", "review", "captions", "clean"],
  podcast: ["enhance", "notes"],
  course: ["guides", "notes", "enhance"],
  recording: ["notes", "guides", "review"],
  thread: ["instagram"],
  newsletter: [],
  article: [],
  other: [],
};

/** The tools "What will you make?" ticks, in `mine`'s order: the Workshop for everything, the rest per answer. */
export const toolsFor = (makes: readonly Make[], mine: readonly Tool[]): Tool[] => {
  const want = new Set<Tool>(["workshop", ...makes.flatMap((m) => MAKE_TOOLS[m])]);
  return mine.filter((t) => want.has(t));
};
