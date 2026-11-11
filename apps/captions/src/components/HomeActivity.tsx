import { useCachedLoad } from "@/lib/local-cache";
import { Link } from "react-router";
import { CircleAlert, Eye, Inbox, KeyRound, Loader2, MessageSquare, Pause, type LucideIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { canUse, useMe, type Me } from "@/lib/auth";
import type { EditSummary } from "@contracts/editor";
import type { ActivityRow } from "@contracts/activity";
import { listEdits } from "@/lib/editor";
import { listReviewAssets, type ReviewAsset } from "@/lib/review";
import { useSessionSummaries, type SessionSummary } from "@/lib/workshop-summary";

export interface TodoRow {
  key: string;
  to: string;
  text: string;
  icon: "review" | "failed" | "key";
}

/** What waits on you, from the lists the Home page already reads: videos to review, and edits whose last step failed
 *  or needs a key. Pure, so the rows can be tested without a server. */
export function todoRows(edits: EditSummary[], assets: ReviewAsset[]): TodoRow[] {
  const review = assets
    .filter((a) => a.approval.status === "needs_review")
    .map((a): TodoRow => ({ key: `r:${a.id}`, to: `/review/${a.id}`, text: `${a.name} is waiting for your review`, icon: "review" }));
  const edit = edits
    .filter((e) => e.last?.state === "failed" || e.last?.state === "needs_key")
    .map((e): TodoRow => {
      const needsKey = e.last?.state === "needs_key";
      return {
        key: `e:${e.id}`,
        to: `/editor/${e.id}`,
        text: needsKey ? `${e.name} needs a key to continue` : `${e.name}: the last step failed`,
        icon: needsKey ? "key" : "failed",
      };
    });
  return [...review, ...edit];
}

/** The two lists the Activity list and Home's badges count, from their saved copies (the same keys as Review's page), live. */
export function useTodoLists(me: Me | null) {
  const edits = useCachedLoad<EditSummary[]>(canUse(me, "editor") ? "/api/editor" : null, listEdits);
  const assets = useCachedLoad<ReviewAsset[]>(canUse(me, "review") ? "/api/review" : null, listReviewAssets);
  return {
    edits: edits.data ?? [],
    assets: assets.data ?? [],
    refresh: () => void Promise.all([edits.refresh(), assets.refresh()]).catch(() => {}),
  };
}

const loadActivity = () =>
  fetch("/api/activity").then((r) => (r.ok ? (r.json() as Promise<ActivityRow[]>) : Promise.reject(new Error(`Request failed (${r.status})`))));

/** The topics of the tools whose work has a row (api/activity.ts): a change to one reads the rows again. */
const WORK_TOPICS = ["library", "editor", "exports", "instagram", "clips", "enhance", "review", "documents", "projects", "workshop"];

/** GET /api/activity: the app's own background work and the plug-ins' rows, live: read again when a tool with running
 *  work changes (lib/sync.ts), never on a timer, this window's own writes included (a stop pressed here ends a row).
 *  An upload's progress is read again when the list opens. */
export function useActivityRows(me: Me | null) {
  return useCachedLoad<ActivityRow[]>(me ? "/api/activity" : null, loadActivity, { topic: WORK_TOPICS, own: true });
}

/** One line of the list. `reason`: why running work waits (a plan's limit), said once, in place of a spinner. */
export interface Line {
  key: string;
  to: string;
  title: string;
  detail: string;
  icon: "running" | "review" | "failed" | "key" | "reply";
  progress?: number;
  reason?: string;
}

/**
 * The list's two parts. Running: the server's working rows and Workshop replies being written. Waiting on you: videos to
 * review, edits that failed or need a key, Workshop replies you haven't read, then the server's ready rows. A row with
 * buttons is the menu bar's own (they start and stop things on the Mac): it is left out here. Pure.
 */
export function activityLines(server: ActivityRow[], sessions: SessionSummary[], todo: TodoRow[]): { running: Line[]; waiting: Line[] } {
  const rows = server.filter((r) => !r.actions?.length);
  const line = (r: ActivityRow, icon: Line["icon"]): Line => ({
    key: r.id,
    to: r.href,
    title: r.title,
    detail: r.detail,
    icon,
    ...(r.progress !== undefined ? { progress: r.progress } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
  });
  const session = (s: SessionSummary, detail: string, icon: Line["icon"]): Line => ({ key: `s:${s.id}`, to: `/workshop/sessions/${s.id}`, title: s.title, detail, icon });
  return {
    running: [
      ...rows.filter((r) => r.state === "working").map((r) => line(r, "running")),
      ...sessions.filter((s) => s.working).map((s) => session(s, "Workshop · writing a reply", "running")),
    ],
    waiting: [
      ...todo.map((t): Line => ({ key: t.key, to: t.to, title: t.text, detail: "", icon: t.icon })),
      ...sessions.filter((s) => s.ready && !s.working).map((s) => session(s, "Workshop · new reply", "reply")),
      ...rows.filter((r) => r.state === "ready").map((r) => line(r, "key")),
    ],
  };
}

/** What a Home tile says while work runs at its tool: the chip's words, its hover line, and whether it is moving. */
export interface Chip {
  text: string;
  title: string;
  moving: boolean;
}

/** Each server row's tile and its word, by the page it opens ("/editor/e1" → the AI Editor's tile); the first line that
 *  matches takes the row, so a longer page comes before the one it starts with. */
const TILE: [string, string, string][] = [
  ["/library", "/library", ""],
  ["/editor", "/editor", "editing"],
  ["/captions?view=projects", "/captions?view=projects", "captioning"],
  ["/captions", "/captions?view=projects", "exporting"],
  ["/instagram", "/instagram", "reading"],
  ["/clips", "/clips", "processing"],
  ["/enhance", "/enhance", "enhancing"],
  ["/review", "/review", "preparing"],
  ["/documents", "/documents", "writing"],
  ["/workshop", "/workshop", "reading"],
];
const lineOf = (href: string) => TILE.find(([p]) => href === p || href.startsWith(`${p}/`) || href.startsWith(`${p}?`));

/**
 * Home's tiles, by their page: the Media Library says how far it is ("45%"), or when the plan's limit lets it carry on
 * ("until 5pm"); the other tools how many things run there and one word ("2 editing", "1 reading"), two kinds of work at
 * one tool "2 working"; the Workshop how many replies are being written. The hover lists what runs. Pure.
 */
export function runningByTile(server: ActivityRow[], writing: number): Record<string, Chip> {
  const out: Record<string, Chip> = {};
  const counts: Record<string, number> = {};
  const count = (tile: string, n: number, verb: string, title: string, moving: boolean) => {
    const before = out[tile];
    counts[tile] = (counts[tile] ?? 0) + n;
    out[tile] = { text: `${counts[tile]} ${before ? "working" : verb}`, title: before ? `${before.title}\n${title}` : title, moving: moving || !!before?.moving };
  };
  if (writing) count("/workshop", writing, "writing", `${writing} writing`, true);
  for (const line of TILE) {
    const [, tile, verb] = line;
    const rows = server.filter((r) => r.state === "working" && lineOf(r.href) === line);
    if (!rows.length) continue;
    const moving = rows.filter((r) => !r.reason);
    // the hover: what each thing is (the Media Library's one row says how far it is)
    const title = rows.map((r) => r.reason ?? (verb ? r.title : r.detail)).join("\n");
    if (verb) count(tile, rows.length, verb, title, moving.length > 0);
    else if (moving.length) {
      // the stage furthest behind: a folder still being taken in at 92% while its clips are prepared at 39% says 39%
      const far = Math.min(...moving.map((r) => r.progress ?? 1));
      out[tile] = { text: moving.some((r) => r.progress !== undefined) ? `${Math.round(far * 100)}%` : "working", title, moving: true };
    }
    else out[tile] = { text: until(rows[0].reason!), title, moving: false };
  }
  return out;
}

/** "…; it resets 5pm. They carry on…" → "until 5pm" (the plan's own words, contracts/plans.ts limitMessage). */
const until = (reason: string) => {
  const at = /resets ([^.;]+)/.exec(reason)?.[1];
  return at ? `until ${at}` : "waiting";
};

/** Home's running chips, from the same saved rows as the list. */
export function useRunning(me: Me | null): Record<string, Chip> {
  const server = useActivityRows(me).data ?? [];
  const writing = (useSessionSummaries() ?? []).filter((s) => s.working).length;
  return runningByTile(server, canUse(me, "workshop") ? writing : 0);
}

/** Home's Activity list: an icon that turns while something runs and counts what waits on you, opening the two parts. */
export function HomeActivity() {
  const me = useMe();
  if (!me) return null;
  return <ActivityButton me={me} />;
}

const ICON: Record<Line["icon"], LucideIcon> = { running: Loader2, review: Eye, failed: CircleAlert, key: KeyRound, reply: MessageSquare };
const TONE: Record<Line["icon"], string> = { running: "text-muted-foreground", review: "text-amber-500", failed: "text-red-500", key: "text-amber-400", reply: "text-emerald-500" };

function ActivityButton({ me }: { me: Me }) {
  const { edits, assets, refresh } = useTodoLists(me);
  const server = useActivityRows(me);
  const sessions = useSessionSummaries() ?? [];
  const { running, waiting } = activityLines(server.data ?? [], canUse(me, "workshop") ? sessions : [], todoRows(edits, assets));
  const moving = running.some((l) => !l.reason);
  const label = ["Activity", running.length && `${running.length} running`, waiting.length && `${waiting.length} waiting on you`].filter(Boolean).join(", ");
  return (
    <Popover onOpenChange={(open) => open && (refresh(), void server.refresh().catch(() => {}))}>
      <PopoverTrigger asChild>
        <button
          title="Activity"
          aria-label={label}
          className="relative rounded-lg p-2 text-muted-foreground outline-none hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
        >
          {moving ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" /> : <Inbox className="h-4 w-4" />}
          {waiting.length > 0 && (
            <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
              {waiting.length > 9 ? "9+" : waiting.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" collisionPadding={12} className="w-96 max-w-[calc(100vw-24px)] p-0">
        <p className="border-b px-3 py-2 text-sm font-medium">Activity</p>
        <div className="max-h-96 overflow-y-scroll pb-1">
          {!running.length && !waiting.length && <p className="px-3 py-8 text-center text-xs text-muted-foreground">Nothing is running or waiting on you.</p>}
          <Part label="Running" lines={running} />
          <Part label="Waiting on you" lines={waiting} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Part({ label, lines }: { label: string; lines: Line[] }) {
  if (!lines.length) return null;
  return (
    <section aria-label={label}>
      <h3 className="px-3 pb-1 pt-2.5 text-[11px] font-medium text-muted-foreground">{label}</h3>
      {lines.map((l) => {
        const Icon = l.reason ? Pause : ICON[l.icon];
        return (
          <Link key={l.key} to={l.to} className="flex min-w-0 items-start gap-2 px-3 py-2 text-xs hover:bg-accent">
            <Icon className={`mt-px h-3.5 w-3.5 shrink-0 ${TONE[l.icon]} ${l.icon === "running" && !l.reason ? "motion-safe:animate-spin" : ""}`} />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="line-clamp-3 min-w-0 break-words">
                {l.title}
                {l.detail && <span className="text-muted-foreground">{` ${l.detail}`}</span>}
              </span>
              {l.progress !== undefined && !l.reason && <Progress value={l.progress * 100} className="h-1" />}
              {l.reason && <span className="text-amber-700 dark:text-amber-300">{l.reason}</span>}
            </span>
          </Link>
        );
      })}
    </section>
  );
}
