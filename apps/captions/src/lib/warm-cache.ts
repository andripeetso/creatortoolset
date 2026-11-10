import { canUse, useAuth } from "./auth";
import { readCached, warmCached } from "./local-cache";
import { listReviewAssets, listReviewProjects } from "./review";
import { getSession, listChat, listDocuments as listPieces, listSessions, listFrameworks, listRules, getWorkshopAvailability, saveSession, type SessionRow } from "./workshop";
import { listAccounts } from "./instagram";
import { listClips } from "./clips";
import { listDocuments } from "./documents";
import { listEnhance } from "./enhance";
import { useWorkspace } from "./workspace";
import { listSessions as listProjects } from "./persist";

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
  if (canUse(me, "instagram")) job(`instagram/accounts?p=${pid}`, () => listAccounts());
  if (canUse(me, "captions")) job("caption-projects", listProjects);
  if (canUse(me, "notes")) job("/api/clips", listClips);
  if (canUse(me, "guides")) job("/api/documents", listDocuments);
  if (canUse(me, "enhance")) job("/api/enhance", listEnhance);
  await Promise.all(jobs);
  await warmRecentSessions();
}

/**
 * The most recent sessions' own contents (session, documents, chat) saved on this device, one session at a time, after
 * the session list is saved. Run after the list loads; a failed session is skipped and opens as before.
 */
export async function warmRecentSessions(count = 3): Promise<void> {
  const me = useAuth.getState().me;
  if (!me) return;
  const pid = useWorkspace.getState().currentProjectId ?? "";
  const rows = readCached<SessionRow[]>(me.username, `workshop/sessions?p=${pid}`) ?? [];
  for (const row of rows.slice(0, count)) {
    try {
      const [session, docs, messages] = await Promise.all([getSession(row.id), listPieces(row.id), listChat(row.id)]);
      const activeDocId = (docs.find((d) => d.kind !== "notes") ?? docs[0])?.id ?? null;
      saveSession(me.username, row.id, { session, docs, messages, activeDocId });
    } catch {
      // this one opens as before
    }
  }
}
