import { useEffect, useRef } from "react";
import { create } from "zustand";
import { planWarning, type Feature, type PlanId } from "@contracts/plans";
import { DEFAULT_TOOLS, type SetupView, type Tool } from "@contracts/tools";
import { DEFAULT_WORK_PREFS, type Make, type WorkPrefs } from "@contracts/work-prefs";
import { confirmDialog } from "./dialogs";
import { useAuth } from "./auth";
import { putCached, readCached, useCachedLoad, warmCached } from "./local-cache";
import { boot, onTopic, seqNow, whenVisible } from "./sync";
import { useWorkspace } from "./workspace";

export type { SetupView };

/**
 * First run: three screens for everyone (Connect your AI, What do you make?, How do you work best?), then Home.
 * "In my own AI" and "Both" are followed by one more, `own`: Creator Toolset is installed in her AI apps there, so the
 * answer is carried out where she can see it. Questions and their installs only: no job to do is asked of her.
 */
export const SETUP_PATH = ["agents", "make", "how"] as const;
/** Screens that open alone from a `?setup=` link and close with Done. `own` is also the path's last screen (stepsFor). */
export const SIDE_STEPS = ["connect", "folders", "own"] as const;
export const SETUP_STEPS = [...SETUP_PATH, ...SIDE_STEPS] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** The click path: the three screens, and `own` after them when the answer to the third is "In my own AI" or "Both". */
export const stepsFor = (talk?: string | null): readonly SetupStep[] => (talk === "chat" || talk === "both" ? [...SETUP_PATH, "own"] : SETUP_PATH);

/** Ids from the older, longer setups still open the screen they now belong to. */
const OLD_STEP: Record<string, SetupStep> = { tools: "make", ai: "agents", project: "make", left: "make", done: "make", try: "make" };

/** The `?setup=` value as a step, or null when it names none (then setup opens on its first step). */
export function setupStepFromParam(v: string | null): SetupStep | null {
  if (!v) return null;
  const id = Object.hasOwn(OLD_STEP, v) ? OLD_STEP[v]! : v;
  return (SETUP_STEPS as readonly string[]).includes(id) ? (id as SetupStep) : null;
}

/** The project made quietly on "What do you make?": its name, or null when the account already has one (then none is made). */
export const firstProjectName = (makes: readonly Make[], projects: number): string | null =>
  projects > 0 ? null : makes.length === 1 ? MAKE_NAMES[makes[0]!] : "My videos";

/** Setup is finished once `done` is saved with tools picked (leaving the last screen saves both). */
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
 * Whether the setup window is up: never on a phone (setup happens on the computer); asked for by `?setup=` (Home's
 * card, Settings); or by itself on a first sign-in (`firstRun`, setupOpensItself) that isn't finished and didn't press
 * Not now.
 */
export const setupOpen = (view: Pick<SetupView, "done" | "tools"> | null, asked: string | null, at: { firstRun: boolean; phone: boolean }): boolean =>
  !!view && !at.phone && (asked !== null || (at.firstRun && !setupFinished(view) && !setupDismissed()));

/** Whether the setup window is on screen right now (SetupDialog sets it): the assistant dock and popup stay away only then. */
export const useSetupShown = create<{ shown: boolean }>(() => ({ shown: false }));

/** Remembers the step Not now was pressed on, for Finish setting up. */
export function rememberLater(step: SetupStep): void {
  write("session", LATER, step);
}

/** Where Finish setting up reopens: the screen Not now was pressed on, else the first. Only ever a screen on the path. */
export function resumeStep(): SetupStep {
  const s = setupStepFromParam(read("session", LATER));
  return s && stepsFor().includes(s) ? s : SETUP_PATH[0];
}

/** Where the Mac app is downloaded: what a phone is given, since setup happens on the computer. */
export const DOWNLOAD_URL = "https://creatortoolset.com/download";

/**
 * Hands the download link over from a phone: the share sheet where there is one, else the clipboard, else ("shown",
 * a plain-http address has neither) the caller shows the address to type.
 */
export async function shareDownload(nav: Pick<Navigator, "share" | "clipboard"> = navigator): Promise<"shared" | "copied" | "shown"> {
  try {
    if (nav.share) return await nav.share({ url: DOWNLOAD_URL }).then(() => "shared" as const);
    if (nav.clipboard) return await nav.clipboard.writeText(DOWNLOAD_URL).then(() => "copied" as const);
  } catch (e) {
    if ((e as Error).name === "AbortError") return "shared"; // she closed the share sheet herself
  }
  return "shown";
}

/** Opens setup at a step from anywhere (Home, Settings): sets `?setup=` and tells the router the address changed. */
export function openSetupAt(step: SetupStep): void {
  const url = new URL(window.location.href);
  url.searchParams.set("setup", step);
  window.history.pushState(window.history.state, "", url);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

/**
 * Whether setup opens by itself: only on an account's first sign-in (an account with more than one login never gets it,
 * whatever this browser remembers: a new address has no memory of it), and only once its projects have really loaded
 * and it has none. Recomputed on every change, so a project arriving closes it. Settings → Setup and ?setup= always open it.
 */
export const setupOpensItself = (a: { logins: number | null | undefined; loaded: boolean; projects: number }): boolean =>
  (a.logins ?? 0) <= 1 && a.loaded && a.projects === 0;

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
  hidden?: Tool[];
  plan?: PlanId | null;
  done?: boolean;
}

/** The setup's saved copy (lib/local-cache.ts): the dot on each Home tile and Finish setting up paint from it. */
const SETUP_KEY = "/api/setup";
/** The change the newest read of the setup started at: a notice at or before it is already in it. */
let readAt = { seq: -1, boot: "" };
const fetchSetup = () => {
  readAt = { seq: seqNow(), boot: boot() };
  return fetch(SETUP_KEY).then((r) => json<SetupView>(r));
};
const me = () => useAuth.getState().me?.username ?? null;

/** The account's setup (api/setup.ts), shared by the dialog, the first-open checklist, Settings → Setup and the plan warnings. */
export const useSetup = create<{ view: SetupView | null; load: () => Promise<SetupView | null>; save: (p: SetupPatch) => Promise<void> }>((set) => ({
  view: null,
  load: async () => {
    try {
      await warmCached(SETUP_KEY, fetchSetup);
    } catch {
      return null; // a guest or the demo has none
    }
    const view = readCached<SetupView>(me(), SETUP_KEY);
    set({ view });
    return view;
  },
  save: (p) =>
    fetch("/api/setup", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) })
      .then((r) => json<SetupView>(r))
      .then((view) => (putCached(me(), SETUP_KEY, view), set({ view }))),
}));

/** Before the first render (main.tsx): the last setup this account saw, so Home's marks are there on the first frame. */
export const seedSetup = () => useSetup.setState({ view: readCached<SetupView>(me(), SETUP_KEY) });

/** What a setup's "have" also comes from: keys, providers, social logins, paired computers, the Apify key. */
const FEEDS = ["my-keys", "providers", "connectors", "devices", "instagram"];

/**
 * Keeps the setup live while signed in (App.tsx): its saved copy at once, read again when "setup" or one of its FEEDS
 * changes (another window, a Mac coming online, a provider starting to answer) and when the project count changes.
 * No timer.
 */
export function useSetupSync(): void {
  const user = useAuth((s) => s.me?.username ?? null);
  const { data, refresh } = useCachedLoad<SetupView>(user ? SETUP_KEY : null, fetchSetup, { topic: "setup" });
  useEffect(() => {
    if (data) useSetup.setState({ view: data });
  }, [data]);
  useEffect(() => {
    if (!user) return;
    const stale = (latest: number) => readAt.boot !== boot() || latest > readAt.seq;
    const offs = FEEDS.map((t) => onTopic(t, (latest) => {
      if (stale(latest)) whenVisible("setup:feeds", () => void (stale(latest) && refresh().catch(() => {})));
    }));
    return () => offs.forEach((off) => off());
  }, [user, refresh]);
  // "project" in have: a project made or deleted (here or elsewhere) shows in the workspace first
  const projects = useWorkspace((s) => (s.loaded ? s.projects.length : null));
  const was = useRef(projects);
  useEffect(() => {
    if (was.current !== null && projects !== null && projects !== was.current) void refresh().catch(() => {});
    was.current = projects;
  }, [projects, refresh]);
}

/**
 * While `on` (a setup screen is up): reads the setup once, again when the window comes back to the front (an install
 * finished elsewhere), and a moment after a click on it (a key or a login saved in one of its rows: this window's own
 * writes send it no notice). Live otherwise (useSetupSync).
 * ponytail: a click stands in for "this window saved something"; read on the write itself once the change stream
 * tells a window about its own writes.
 */
export function useSetupLive(on: boolean) {
  const load = useSetup((s) => s.load);
  useEffect(() => {
    if (!on) return;
    void load();
    const again = () => void load();
    let t: ReturnType<typeof setTimeout> | undefined;
    const clicked = () => (clearTimeout(t), (t = setTimeout(again, 1500)));
    window.addEventListener("focus", again);
    document.addEventListener("click", clicked, true);
    return () => (clearTimeout(t), window.removeEventListener("focus", again), document.removeEventListener("click", clicked, true));
  }, [on, load]);
}

/** Opens a tool's checklist from anywhere (a tool's own "Set up" link); FirstOpen listens. */
export const openToolSetup = (tool: Tool) => window.dispatchEvent(new CustomEvent("ct-tool-setup", { detail: tool }));

/**
 * Settings closed (App.tsx unmounts its modal). Settings is the only place providers, keys and tools change, and the
 * page behind it stays mounted: it re-reads what Settings may have changed (the Workshop's AI check, Home's marks).
 */
export const SETTINGS_CLOSED = "ct-settings-closed";
export function onSettingsClosed(again: () => void): () => void {
  window.addEventListener(SETTINGS_CLOSED, again);
  return () => window.removeEventListener(SETTINGS_CLOSED, again);
}

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

/** The plan the warning reads: the one a reading tells, else the person's answer, else none. */
export const planToWarnBy = (view: Pick<SetupView, "detected" | "plan"> | null | undefined): PlanId | null => view?.detected ?? view?.plan ?? null;

/**
 * Before a heavy AI run: on a Pro or Plus plan, says how much of the 5-hour window it usually takes and asks first.
 * True = go ahead (no plan given, a bigger plan, a light run, or they said so). The plan a reading tells (`detected`)
 * wins over the one the person picked.
 */
export async function confirmHeavy(feature: Feature, count = 1): Promise<boolean> {
  const view = useSetup.getState().view ?? (await useSetup.getState().load());
  const warning = planWarning(planToWarnBy(view), feature, count);
  if (!warning) return true;
  return confirmDialog({ title: "This can use up your plan's limit", body: warning, ok: "Run it anyway" });
}

/** "What do you make?": each answer, the words setup shows for it. */
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
 * The tools "What do you make?" ticks, in `mine`'s order: the default tools (always on, DEFAULT_TOOLS) plus the extra
 * each answer fits. Not sure yet picks everything instead (the dialog does that itself).
 */
export const toolsFor = (makes: readonly Make[], mine: readonly Tool[]): Tool[] => {
  const want = new Set<Tool>([...DEFAULT_TOOLS, ...makes.flatMap((m) => (MAKE_EXTRA[m] ? [MAKE_EXTRA[m]!] : []))]);
  return mine.filter((t) => want.has(t));
};
