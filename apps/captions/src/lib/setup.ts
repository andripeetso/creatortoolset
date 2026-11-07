import { useEffect } from "react";
import { create } from "zustand";
import { planWarning, type Feature, type PlanId } from "@contracts/plans";
import { usesAi, type SetupView, type Tool } from "@contracts/tools";
import { confirmDialog } from "./dialogs";

export type { SetupView };

/** The first-run steps, in order. */
export type SetupStep = "account" | "tools" | "project" | "ai" | "left";

/**
 * Which steps show: the account only in the Mac app (it does the sign-in), the first project only for the Workshop or
 * the Analyzer, the AI only when a ticked tool uses it. Which tools and What's left always.
 */
export function setupSteps(ticked: readonly Tool[], o: { account: boolean }): SetupStep[] {
  return [
    ...(o.account ? (["account"] as const) : []),
    "tools",
    ...(ticked.includes("workshop") || ticked.includes("instagram") ? (["project"] as const) : []),
    ...(ticked.some(usesAi) ? (["ai"] as const) : []),
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
