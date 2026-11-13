import { useEffect, useMemo, useState } from "react";
import { Clapperboard, NotebookPen, type LucideIcon } from "lucide-react";
import { canUse, useMe } from "@/lib/auth";
import { listEdits } from "@/lib/editor";
import { useSessionSummaries } from "@/lib/workshop-summary";
import { useWorkspace } from "@/lib/workspace";
import { webPlugins } from "@/plugins.gen";

/**
 * Work in progress: the things a person carries on with, each on its own page (a video edit, a Workshop session). The
 * new-chat screen offers the newest of them, so a chat can start beside the thing it is about.
 */
export interface WorkItem {
  key: string;
  /** What it is, in a word: "Edit", "Workshop". */
  kind: string;
  icon: LucideIcon;
  title: string;
  /** Its page. */
  to: string;
  /** When it was last worked on. */
  at: number;
  /** Something is running in it now. */
  busy?: boolean;
}

/** The newest of several lists, newest first; a thing with no name is left out. */
export function recentWork(lists: WorkItem[][], max = 8): WorkItem[] {
  return lists
    .flat()
    .filter((w) => w.title.trim())
    .sort((a, b) => b.at - a.at)
    .slice(0, max);
}

/** The one of `items` whose page `pathname` is, or is inside (an edit's draft is inside the edit). */
export const workAt = (items: WorkItem[], pathname: string): WorkItem | undefined =>
  items.filter((w) => pathname === w.to || pathname.startsWith(`${w.to}/`)).sort((a, b) => b.to.length - a.to.length)[0];

/**
 * The newest work of the person signed in, in the project they are in (a project keeps its own content apart):
 * Workshop sessions and video edits of that project. A plug-in that has edits of its own (it replaces the editor)
 * gives them through its `work` (lib/plugin.ts), and the app's own list, which is empty there, is left out. Read
 * again when the project changes; null until the first of it is known.
 */
export function useRecentWork(): WorkItem[] | null {
  const me = useMe();
  const sessions = useSessionSummaries();
  const project = useWorkspace((s) => s.currentProjectId);
  // what was fetched, and for which project: another project's list is never shown, not even for a moment
  const [got, setGot] = useState<{ project: string | null; items: WorkItem[] } | null>(null);
  const user = me?.username;
  useEffect(() => {
    if (!me) return;
    let live = true;
    const own = webPlugins.flatMap((p) => p.work ?? []).filter((w) => !w.gate || canUse(me, w.gate));
    const loads = own.map((w) => w.list(project).then((rows) => rows.map((r): WorkItem => ({ key: `${w.kind}:${r.id}`, kind: w.kind, icon: w.icon, title: r.title, to: r.to, at: r.at, ...(r.busy ? { busy: true } : {}) }))));
    if (canUse(me, "editor") && !webPlugins.some((p) => p.replaces?.editor))
      loads.push(listEdits(project).then((rows) => rows.map((e): WorkItem => ({ key: `edit:${e.id}`, kind: "Edit", icon: Clapperboard, title: e.name, to: `/editor/${e.id}`, at: e.updatedAt, ...(e.last?.state === "running" ? { busy: true } : {}) }))));
    // a list that fails is left out: the rest still shows
    void Promise.allSettled(loads).then((done) => live && setGot({ project, items: done.flatMap((d) => (d.status === "fulfilled" ? d.value : [])) }));
    return () => {
      live = false;
    };
    // the person, not the object: `me` is a new object on every read of the account
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, project]);
  const fetched = got?.project === project ? got.items : null;
  return useMemo(() => {
    if (!me || (fetched === null && sessions === null)) return null;
    const workshop = canUse(me, "workshop")
      ? (sessions ?? []).map((s): WorkItem => ({ key: `session:${s.id}`, kind: "Workshop", icon: NotebookPen, title: s.title, to: `/workshop/sessions/${s.id}`, at: s.updatedAt, ...(s.working ? { busy: true } : {}) }))
      : [];
    return recentWork([workshop, fetched ?? []]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, sessions, fetched]);
}
