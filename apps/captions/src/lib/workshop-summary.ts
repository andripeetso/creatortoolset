import { useMemo } from "react";
import { useAuth } from "@/lib/auth";
import { putCached, readCached, useCachedLoad, warmCached } from "@/lib/local-cache";
import type { PieceKind, SessionStatus } from "@/lib/workshop";
import { useWorkspace } from "@/lib/workspace";

/**
 * Every Workshop session at a glance (GET /api/workshop/sessions/summary), shared by the sidebar, the tab title, Home
 * and the Mac app's Dock badge. A saved list (lib/local-cache): it paints at once and refetches when the Workshop
 * changes anywhere (a reply's progress included), never on a timer.
 */
export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  updatedAt: number;
  projectId?: string;
  pinned?: boolean;
  kinds: PieceKind[];
  /** a reply is being written */
  working: boolean;
  /** a reply finished that you haven't looked at */
  ready: boolean;
  replyAt?: number;
}

const keyFor = (projectId: string | null) => `workshop/summary?p=${projectId ?? ""}`;
// sessions marked seen here whose seen the server may not have yet: a list fetched earlier can't bring the dot back
const seenHere = new Set<string>();
// lists fetched since this page loaded: a saved "working" from an earlier visit is not shown (no stale spinner)
const fetched = new Set<string>();

const load = (projectId: string | null) => async (): Promise<SessionSummary[]> => {
  const r = await fetch(`/api/workshop/sessions/summary${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  const got = (await r.json()) as SessionSummary[];
  for (const x of got) if (!x.ready) seenHere.delete(x.id);
  fetched.add(keyFor(projectId));
  return got;
};

export function refreshSummaries(): Promise<void> {
  const pid = useWorkspace.getState().currentProjectId;
  return warmCached(keyFor(pid), load(pid)).catch(() => {});
}

export function useSessionSummaries(): SessionSummary[] | null {
  const pid = useWorkspace((s) => s.currentProjectId);
  const { data } = useCachedLoad<SessionSummary[]>(keyFor(pid), load(pid));
  const live = fetched.has(keyFor(pid));
  return useMemo(
    () => data?.map((x) => (x.ready && seenHere.has(x.id) ? { ...x, ready: false } : !live && x.working ? { ...x, working: false } : x)) ?? null,
    [data, live],
  );
}

/** A change to the saved rows of the project you're in (they repaint everywhere at once). */
function patchRows(fn: (rows: SessionSummary[]) => SessionSummary[]) {
  const user = useAuth.getState().me?.username;
  const key = keyFor(useWorkspace.getState().currentProjectId);
  const rows = readCached<SessionSummary[]>(user, key);
  if (rows) putCached(user, key, fn(rows));
}

/** You've seen this session's newest reply: its dot goes at once, and on every device once the server has it. */
export function markSeen(sessionId: string, messageId: string) {
  if (!seenHere.has(sessionId)) {
    seenHere.add(sessionId);
    patchRows((rows) => rows.map((r) => (r.id === sessionId && r.ready ? { ...r, ready: false } : r)));
  }
  void fetch(`/api/workshop/sessions/${sessionId}/seen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId }),
  }).catch(() => {});
}

/** Mark unread (the menu): the newest reply's Done dot comes back, here at once and on the server. */
export function markUnread(sessionId: string) {
  seenHere.delete(sessionId);
  patchRows((rows) => rows.map((r) => (r.id === sessionId && r.replyAt && !r.working ? { ...r, ready: true } : r)));
  void fetch(`/api/workshop/sessions/${sessionId}/seen`, { method: "DELETE" }).catch(() => {});
}

/** A change made here (a status, a title) shows in the sidebar now; this tab skips its own write's notice. */
export function patchSummary(sessionId: string, patch: Partial<SessionSummary>) {
  patchRows((rows) => rows.map((r) => (r.id === sessionId ? { ...r, ...patch } : r)));
}

/** Script done, not yet posted: Ready, In Production, Editing, Ready to post (the list's and the sidebar's fold). */
export const MAKING: SessionStatus[] = ["ready", "production", "editing", "toPost"];

/**
 * The sidebar's groups, the same as the sessions list's: pinned first, then by status. Rows keep their order when a
 * reply is being written or is waiting: only the icon changes.
 * keepOrder: the caller sorted them (by name). ⌘1–9 follow this order.
 */
export function groupSummaries(all: SessionSummary[], keepOrder = false) {
  const sorted = [...all].sort((a, b) => (keepOrder ? 0 : b.updatedAt - a.updatedAt));
  const rest = sorted.filter((r) => !r.pinned);
  return {
    pinned: sorted.filter((r) => r.pinned),
    writing: rest.filter((r) => r.status === "draft" || r.status === "writing"),
    making: rest.filter((r) => MAKING.includes(r.status as SessionStatus)),
    published: rest.filter((r) => r.status === "published"),
    shelved: rest.filter((r) => r.status === "shelved"),
  };
}
