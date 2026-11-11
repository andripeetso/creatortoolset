import type { Provider } from "@/components/setup/AccountStep";
import { canUse, useAuth, type Me } from "./auth";
import { listAutomations } from "./automations";
import { getConnectors } from "./connectors";
import { getProviders } from "./providers";
import { getWorkspace } from "./workspaces";
import { forgetCached, readCached, warmCached } from "./local-cache";
import { listReviewAssets, listReviewProjects } from "./review";
import { getSession, keepSession, listChat, listDocuments as listPieces, listSessions, listFrameworks, listRules, getWorkshopAvailability, sessionKeys, type SessionRecord, type SessionRow } from "./workshop";
import { listAccounts, listPosts, type ListPostsQuery } from "./instagram";
import { listEdits } from "./editor";
import { CLIPS_AVAILABILITY, getClipsAvailability, listClips } from "./clips";
import { listDocuments } from "./documents";
import { listEnhance } from "./enhance";
import { PROJECT_ACCOUNTS_KEY, useWorkspace } from "./workspace";
import { listSessions as listProjects } from "./persist";

/** No sign-in apps, as Account keeps it (AccountSection.tsx). Typed by the apps' own list, so a new one fails the build here. */
const NO_SIGN_INS: Record<Provider, boolean> = { apple: false, google: false, github: false };
const get = (url: string) => () => fetch(url).then((r) => (r.ok ? (r.json() as Promise<unknown>) : Promise.reject(new Error(String(r.status)))));

/**
 * Settings' own lists, as [key, loader]: the keys and the saved shapes are the sections' own (components/settings,
 * AdminPanel.tsx; the test checks each key is still read there). Only what this account may read: a team's page on a
 * hosted server, the admin pages for its admins. Social accounts is among them: its read asks no other server (the
 * sign-in service is asked only when the person presses Add, api/lib/connectors/signin-service.ts).
 */
export function settingsLists(me: Pick<Me, "role">, hosted: boolean): Array<[string, () => Promise<unknown>]> {
  const admin = hosted && me.role === "admin";
  return [
    ["/api/providers", getProviders], // Providers, Usage, Devices, Storage, Scheduled tasks
    ["/api/setup/ai", get("/api/setup/ai")], // Providers, Headless access
    ["/api/automations", listAutomations], // Scheduled tasks
    ["/api/devices/storage", get("/api/devices/storage")], // Storage
    ["/api/my-keys", get("/api/my-keys")], // API keys
    ["/api/instagram/apify", get("/api/instagram/apify")], // API keys
    ["/api/connectors", getConnectors], // Social accounts
    ["/api/auth/api-key", get("/api/auth/api-key")], // Headless access
    // Account: a computer with no account answers 401, which the page keeps as "none"
    ["/api/auth/account", () => fetch("/api/auth/account").then((r) => (r.status === 401 ? "none" : r.ok ? (r.json() as Promise<unknown>) : Promise.reject(new Error(String(r.status)))))],
    // Account, Team: the sign-in apps this server has. One that does not answer has none (an own-computer server: 404)
    ["/api/account/providers", () => fetch("/api/account/providers").then((r) => (r.ok ? (r.json() as Promise<unknown>) : NO_SIGN_INS))],
    ...(hosted ? [["/api/workspace", () => getWorkspace().then((team) => ({ team }))] as [string, () => Promise<unknown>]] : []), // Team
    ...(admin ? ["/api/service-keys", "/api/admin/users", "/api/admin/projects"].map((url) => [url, get(url)] as [string, () => Promise<unknown>]) : []), // Admin
  ];
}

/**
 * Fills the saved lists of every screen this account can open (lib/local-cache), so even a first visit paints at once.
 * Run after sign-in and when the project changes. Keys must match the pages' own keys. A list that fails is skipped:
 * its screen fetches as before. Resolves when every list has been tried (Settings → General's Refresh waits for it).
 */
export async function warmScreens(): Promise<void> {
  const me = useAuth.getState().me;
  if (!me) return;
  const pid = useWorkspace.getState().currentProjectId ?? "";
  const jobs: Promise<void>[] = [];
  const job = (url: string, load: () => Promise<unknown>) => {
    jobs.push(warmCached(url, load).catch(() => {}));
  };

  if (canUse(me, "review")) {
    job("/api/review", listReviewAssets);
    job("/api/review/projects", listReviewProjects);
  }
  if (canUse(me, "workshop")) {
    job(`workshop/sessions?p=${pid}`, listSessions);
    job("workshop/frameworks", listFrameworks);
    job("workshop/rules", listRules);
    job("workshop/availability", getWorkshopAvailability);
  }
  if (canUse(me, "instagram")) {
    job(`instagram/accounts?p=${pid}`, () => listAccounts());
    job(PROJECT_ACCOUNTS_KEY, () => listAccounts("", { projectId: null }));
    // the Analyzer's first screen: its feed with the page's starting filters (InstagramPage.tsx listQuery and its defaults)
    const feed: ListPostsQuery = { account: "", tag: "", idea: "inbox", savedFor: "content", sort: "pulled" };
    job(`instagram/posts?${JSON.stringify(feed)}|p=${pid}`, () => listPosts(feed));
  }
  if (canUse(me, "workshop")) {
    // the session page's sidebar (WorkshopSidebar.tsx) before its own first read
    const qs = pid ? `?projectId=${encodeURIComponent(pid)}` : "";
    job(`workshop/summary?p=${pid}`, () => fetch(`/api/workshop/sessions/summary${qs}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))));
  }
  // Home's Activity list and badges (HomeActivity.tsx useTodoLists)
  if (canUse(me, "editor")) job("/api/editor", listEdits);
  if (canUse(me, "captions")) job("caption-projects", listProjects);
  if (canUse(me, "notes")) {
    job("/api/clips", listClips);
    // whether an AI is connected: a clip's page decides by it, before it draws, whether to ask for chapters
    job(CLIPS_AVAILABILITY, getClipsAvailability);
  }
  if (canUse(me, "guides")) job("/api/documents", listDocuments);
  if (canUse(me, "enhance")) job("/api/enhance", listEnhance);
  await Promise.all(jobs);
  await warmRecentSessions();
  // Settings, last (nothing above waits for it): only the lists this device has no copy of yet, so the first-ever open
  // of a section paints like every later one (each section reads its own list again when it opens) and an app start
  // adds no requests after that
  const missing = settingsLists(me, useAuth.getState().hosted).filter(([url]) => readCached(me.username, url) === null);
  await Promise.all(missing.map(([url, load]) => warmCached(url, load).catch(() => {})));
}

/**
 * The current project's most recent sessions' own contents (session, pieces, chat) saved on this device, one session at
 * a time, after the session list is saved, so opening one paints at once. A session whose saved copy is as new as its
 * row is skipped; a failed one is skipped and opens as before. Each stays live once on screen.
 */
export async function warmRecentSessions(count = 10): Promise<void> {
  const me = useAuth.getState().me;
  if (!me) return;
  // the copies before they were live (one record per session, size-capped)
  forgetCached("workshop/session/");
  forgetCached("workshop/saved-sessions");
  const pid = useWorkspace.getState().currentProjectId ?? "";
  const rows = readCached<SessionRow[]>(me.username, `workshop/sessions?p=${pid}`) ?? [];
  for (const row of rows.slice(0, count).reverse()) {
    const k = sessionKeys(row.id);
    const have = readCached<SessionRecord>(me.username, k.session);
    keepSession(me.username, row.id);
    if (have?.updatedAt === row.updatedAt && readCached(me.username, k.docs) && readCached(me.username, k.chat)) continue;
    try {
      await Promise.all([warmCached(k.session, () => getSession(row.id)), warmCached(k.docs, () => listPieces(row.id)), warmCached(k.chat, () => listChat(row.id))]);
    } catch {
      // this one opens as before
    }
  }
}
