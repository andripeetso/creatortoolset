import { useSyncExternalStore } from "react";
import type { PieceKind, SessionStatus } from "@/lib/workshop";
import { appendProjectId, useWorkspace } from "@/lib/workspace";

/**
 * Every Workshop session at a glance (GET /api/workshop/sessions/summary), shared by the sidebar, the tab title and
 * the Mac app's Dock badge. One poll for the
 * whole page: every 3 s while it's in front, every 10 s behind, and at once when you come back to it.
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

let rows: SessionSummary[] | null = null;
// sessions marked seen here whose seen the server may not have yet: a poll that started earlier can't bring the dot back
const seenHere = new Set<string>();
const listeners = new Set<() => void>();
let timer: number | undefined;
// the query of the poll in flight: a poll for another project doesn't wait for it, and its answer is dropped
let inFlight: string | null = null;

const emit = () => listeners.forEach((f) => f());

export async function refreshSummaries(): Promise<void> {
  const params = new URLSearchParams();
  appendProjectId(params); // the project you're in, like the sessions list
  const qs = params.toString();
  if (inFlight === qs) return;
  inFlight = qs;
  try {
    const r = await fetch(`/api/workshop/sessions/summary${qs ? `?${qs}` : ""}`);
    if (inFlight !== qs) return; // the project changed while it ran
    if (r.ok) {
      const got = (await r.json()) as SessionSummary[];
      for (const x of got) if (!x.ready) seenHere.delete(x.id);
      rows = got.map((x) => (x.ready && seenHere.has(x.id) ? { ...x, ready: false } : x));
      emit();
    }
  } catch {
    // offline for a moment: the next tick tries again
  } finally {
    if (inFlight === qs) inFlight = null;
  }
}

// another project: its counts at once, never the last one's
useWorkspace.subscribe((s, prev) => {
  if (s.currentProjectId === prev.currentProjectId) return;
  rows = null;
  emit();
  if (listeners.size) void refreshSummaries();
});

function schedule() {
  window.clearTimeout(timer);
  if (!listeners.size) return;
  timer = window.setTimeout(() => {
    void refreshSummaries().finally(schedule);
  }, document.hidden ? 10_000 : 3_000);
}

const wake = () => {
  if (document.hidden) return;
  void refreshSummaries();
  schedule();
};

function subscribe(f: () => void) {
  listeners.add(f);
  if (listeners.size === 1) {
    void refreshSummaries();
    schedule();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
  }
  return () => {
    listeners.delete(f);
    if (!listeners.size) {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    }
  };
}

export const useSessionSummaries = () => useSyncExternalStore(subscribe, () => rows);

/** You've seen this session's newest reply: its dot goes at once, and on every device once the server has it. */
export function markSeen(sessionId: string, messageId: string) {
  seenHere.add(sessionId);
  if (rows?.some((r) => r.id === sessionId && r.ready)) {
    rows = rows.map((r) => (r.id === sessionId ? { ...r, ready: false } : r));
    emit();
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
  if (rows?.some((r) => r.id === sessionId && r.replyAt && !r.working)) {
    rows = rows.map((r) => (r.id === sessionId ? { ...r, ready: true } : r));
    emit();
  }
  void fetch(`/api/workshop/sessions/${sessionId}/seen`, { method: "DELETE" })
    .then(() => refreshSummaries())
    .catch(() => {});
}

/** A change made here (a status, a title) shows in the sidebar now, not on the next poll. */
export function patchSummary(sessionId: string, patch: Partial<SessionSummary>) {
  if (!rows) return;
  rows = rows.map((r) => (r.id === sessionId ? { ...r, ...patch } : r));
  emit();
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
