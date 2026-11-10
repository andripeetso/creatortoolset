import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { segmentItem, segmentList } from "@/components/SegmentedTabs";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ChevronDown, CircleCheck, Download, Link2, Loader2, NotebookPen, Pencil, Plus, Search, TriangleAlert, X } from "lucide-react";
import { AppBar, ToolIntro } from "@/components/AppBar";
import { ProjectList } from "@/components/workspace/ProjectList";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { PublishButton } from "@/components/community/PublishDialog";
import { FrameworkForm, type FrameworkDraft } from "@/components/workshop/FrameworkForm";
import { KnowledgePanel } from "@/components/workshop/KnowledgePanel";
import { RuleRow } from "@/components/workshop/RuleRow";
import { SessionPosted, SessionStatusSelect } from "@/components/workshop/SessionStatusSelect";
import { SessionMenu } from "@/components/workshop/SessionMenu";
import { SharePopover } from "@/components/workshop/SharePopover";
import { saveObsidianMany } from "@/components/workshop/ExportMarkdown";
import { KIND_DOT } from "@/components/workshop/DocumentTabs";
import { useWorkshopTitle } from "@/components/workshop/WorkshopSidebar";
import { MAKING, patchSummary, useSessionSummaries } from "@/lib/workshop-summary";
import { KindTile } from "@/components/workshop/KindTile";
import { canUse, useAuth, useMe } from "@/lib/auth";
import { timeAgo } from "@/lib/exports";
import { toolsetHomePath } from "@/lib/mobile";
import {
  DOC_KINDS,
  SESSION_STATUSES,
  FRAMEWORK_ROLES,
  createFramework,
  createRule,
  createSession,
  deleteFramework,
  deleteRule,
  AVAILABILITY_LIVE,
  getWorkshopAvailability,
  listFrameworks,
  listRules,
  listSessions,
  postingsOfSession,
  patchFramework,
  patchRule,
  patchSession,
  sessionPath,
  shareSession,
  workshopShareUrl,
  type RuleFields,
  type PieceKind,
  type SessionPatch,
  type SessionRow,
  type SessionStatus,
  type WorkshopFramework,
  type WorkshopRule,
} from "@/lib/workshop";
import { useCachedList, useCachedLoad } from "@/lib/local-cache";
import { onSettingsClosed } from "@/lib/setup";
import { warmRecentSessions } from "@/lib/warm-cache";
import { useWorkspace } from "@/lib/workspace";

type Tab = "sessions" | "projects" | "knowledge" | "frameworks" | "rules";

const label = "mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500";
const secondary =
  "flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const primary =
  "flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50";

export default function WorkshopPage() {
  const home = toolsetHomePath();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const me = useMe();
  const required = useAuth((s) => s.required);
  const allowed = canUse(me, "workshop");
  const currentProjectId = useWorkspace((s) => s.currentProjectId);
  const projects = useWorkspace((s) => s.projects);

  const [tab, setTab] = useState<Tab>("sessions");
  // null until the list is known (saved or fetched): until then the rows' places show as quiet blocks, not an empty line
  const sessionsLoad = useCachedLoad<SessionRow[]>(`workshop/sessions?p=${currentProjectId ?? ""}`, listSessions);
  const sessionsKnown = sessionsLoad.data !== null;
  const sessions = sessionsLoad.data ?? [];
  const loadSessions = sessionsLoad.refresh;
  const setSessions = useCallback(
    (next: SessionRow[] | ((rows: SessionRow[]) => SessionRow[])) => sessionsLoad.set((prev) => (typeof next === "function" ? next(prev ?? []) : next)),
    [sessionsLoad.set],
  );
  const [find, setFind] = useState("");
  const summaries = useSessionSummaries();
  // no sidebar here: this list is the one, ⌘K is its search
  useWorkshopTitle("Content Workshop");
  const findRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        findRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // the list by what each session makes: a type filter and a sort, remembered. Sorted by status by default (the most
  // complete at the bottom); the key is new so the old "recent" default doesn't stick.
  const [kindFilter, setKindFilter] = useState<PieceKind | "all">(() => (localStorage.getItem("workshop:kind") as PieceKind | null) ?? "all");
  const [sortBy, setSortBy] = useState<SessionSort>(() => {
    const v = localStorage.getItem("workshop:list-sort");
    return v === "recent" || v === "type" || v === "status" ? v : "status";
  });
  // the folded groups at the end: Ready + In Production open by default, Published closed
  const [showPublished, setShowPublished] = useState(() => localStorage.getItem("workshop:published") === "open");
  const [showProduction, setShowProduction] = useState(() => localStorage.getItem("workshop:production") !== "closed");
  // Shelved: closed by default, like Published
  const [showShelved, setShowShelved] = useState(() => localStorage.getItem("workshop:shelved") === "open");
  useEffect(() => {
    localStorage.setItem("workshop:published", showPublished ? "open" : "closed");
    localStorage.setItem("workshop:production", showProduction ? "open" : "closed");
    localStorage.setItem("workshop:shelved", showShelved ? "open" : "closed");
  }, [showPublished, showProduction, showShelved]);
  // rows picked for a bulk export or share, like Finder:
  // Shift-click picks the run from the last one clicked, ⌘/Ctrl-click adds or drops one; Esc clears them
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const order = useRef<string[]>([]); // the rows in the order they're shown, for a Shift run
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPicked(new Set());
    // a plain click anywhere but a row or the Share/Export buttons drops the pick, like Finder
    const onDown = (e: PointerEvent) => {
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.button !== 0) return;
      if (!(e.target as Element).closest?.("[data-keep-picked]")) setPicked((p) => (p.size ? new Set() : p));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, []);
  const pickClick = (e: React.MouseEvent, id: string) => {
    if (!e.shiftKey && !e.metaKey && !e.ctrlKey) return false;
    e.preventDefault();
    window.getSelection()?.removeAllRanges(); // a Shift-click extends the page's text selection in Safari and the Mac app
    const from = anchor.current ? order.current.indexOf(anchor.current) : -1;
    const to = order.current.indexOf(id);
    if (e.shiftKey && from >= 0 && to >= 0) {
      const run = order.current.slice(Math.min(from, to), Math.max(from, to) + 1);
      setPicked((p) => new Set([...p, ...run]));
    } else {
      setPicked((p) => {
        const next = new Set(p);
        if (!next.delete(id)) next.add(id);
        return next;
      });
      anchor.current = id;
    }
    return true;
  };
  // right-click on a row: the session menu
  const [menu, setMenu] = useState<{ s: SessionRow; x: number; y: number } | null>(null);
  useEffect(() => {
    localStorage.setItem("workshop:kind", kindFilter);
    localStorage.setItem("workshop:list-sort", sortBy);
  }, [kindFilter, sortBy]);
  // these lists show their saved copy at once and refresh underneath (lib/local-cache); the sessions are per project
  const frameworksList = useCachedList<WorkshopFramework>("workshop/frameworks", listFrameworks);
  const rulesList = useCachedList<WorkshopRule>("workshop/rules", listRules);
  const frameworks = frameworksList.items;
  const rules = rulesList.items;
  const [newRule, setNewRule] = useState("");
  const availList = useCachedLoad("workshop/availability", getWorkshopAvailability, AVAILABILITY_LIVE);
  const avail = availList.data;
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    // the list's recent sessions are saved after it loads, so opening one paints at once
    loadSessions().then(() => warmRecentSessions()).catch(() => {});
    frameworksList.refresh().catch(() => {});
    rulesList.refresh().catch(() => {});
    availList.refresh().catch(() => {});
    // the hook fetches on mount and when the project changes (the sessions key carries the project)
  }, [loadSessions, frameworksList.refresh, rulesList.refresh, availList.refresh]);

  // Settings closed: the AI this page checks may have changed there (the banner reads the same rule as Providers)
  useEffect(() => onSettingsClosed(() => void availList.refresh().catch(() => {})), [availList.refresh]);

  // /workshop?add=id1,id2 — sent from the Analyzer: open a session with those sources.
  const add = searchParams.get("add");
  useEffect(() => {
    if (!allowed || !add) return;
    const ids = add.split(",").filter(Boolean);
    setSearchParams({}, { replace: true });
    createSession({ sourceIds: ids })
      .then((s) => navigate(sessionPath(s.id), { replace: true }))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [allowed, add, navigate, setSearchParams]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      setEditing(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const newSession = () =>
    run("session", async () => {
      const s = await createSession({});
      navigate(sessionPath(s.id));
    });

  const setPosted = (id: string, posted: SessionPatch["posted"]) =>
    patchSession(id, { posted })
      .then((m) => setSessions((rows) => rows.map((s) => (s.id === id ? { ...s, status: m.status, postings: m.postings, posted: m.posted } : s))))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  const setStatus = (id: string, status: SessionStatus) => {
    patchSummary(id, { status });
    setSessions((rows) => rows.map((s) => (s.id === id ? { ...s, status } : s)));
    patchSession(id, { status }).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
      load();
    });
  };

  // the rows the list shows: type filter, sort, then the search
  const q = find.trim().toLowerCase();
  const visible = shownSessions(sessions, kindFilter, sortBy).filter((s) => !q || [s.title, s.query, s.projectName].some((t) => t?.toLowerCase().includes(q)));

  const say = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), 5000);
  };
  // each note saved as its own file; only a note with pictures comes as a zip with a folder inside
  const exportPicked = () =>
    run("export", async () => {
      const { saved, skipped } = await saveObsidianMany([...picked]);
      setPicked(new Set());
      say(`Exported ${saved}${skipped ? `, skipped ${skipped} with no reel or carousel words yet` : ""}`);
    });
  // a share link for each (the same link a session's own Share makes), all of them copied as "title: link" lines.
  // The copy starts inside the click with the links still coming (a ClipboardItem holding a promise): Safari and
  // the Mac app refuse a clipboard write made after an await.
  const sharePicked = () => {
    const rows = sessions.filter((s) => picked.has(s.id));
    const text = (async () => {
      const lines: string[] = [];
      for (const s of rows) lines.push(`${s.title}: ${workshopShareUrl((await shareSession(s.id)).token)}`);
      return lines.join("\n");
    })();
    const copied = navigator.clipboard
      .write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })])
      .then(() => true, () => false);
    return run("share", async () => {
      await text;
      const ok = await copied;
      setPicked(new Set());
      say(`${rows.length} share link${rows.length === 1 ? "" : "s"} ${ok ? "copied" : "made (the copy was refused; each row's Share has its link)"}`);
    });
  };

  const saveFramework = (id: string | "new", f: FrameworkDraft) =>
    run("framework", () =>
      id === "new"
        ? createFramework({ ...f, steps: f.steps })
        : patchFramework(id, { ...f, steps: f.steps }),
    );

  return (
    <div className="relative flex h-dvh flex-col bg-zinc-950 text-zinc-200">
      <AppBar tool="Content Workshop" account={!!me}>
        {me ? (
          <ProjectSwitcher />
        ) : required ? (
          <Link to={home} className="rounded-md px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-200">
            Sign in
          </Link>
        ) : null}
      </AppBar>

      <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto w-[960px] max-w-[96%]">
        <ToolIntro
          icon={NotebookPen}
          title="Content Workshop"
          line={`Search your research, take notes, draft reels, carousels, YouTube scripts, newsletters, X threads and articles.${avail ? ` · ${avail.library} posts in the library` : ""}`}
        />

        {avail && !avail.ai && (
          <p className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            Connect Claude Code or Codex to write. Research and notes work now.
          </p>
        )}

        <div className={cn(segmentList, "mb-5 self-start overflow-x-auto")}>
          {(
            // the counts hold their width while they load, so the tabs don't move
            [
              ["sessions", <>Sessions <span className="inline-block min-w-[3ch] tabular-nums">· {sessionsKnown ? sessions.length : ""}</span></>],
              ["projects", <>Projects <span className="inline-block min-w-[3ch] tabular-nums">· {projects.length}</span></>],
              ["knowledge", "Knowledge"],
              ["frameworks", <>Frameworks <span className="inline-block min-w-[3ch] tabular-nums">· {frameworks.length}</span></>],
              ["rules", <>Rules <span className="inline-block min-w-[7ch] tabular-nums">· {rules.filter((r) => r.on).length} on</span></>],
            ] as Array<[Tab, ReactNode]>
          ).map(([id, text]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setTab(id);
                setEditing(null);
              }}
              className={segmentItem(tab === id)}
            >
              {text}
            </button>
          ))}
        </div>

        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
        {menu ? (
          <SessionMenu
            id={menu.s.id}
            title={menu.s.title}
            status={menu.s.status}
            pinned={menu.s.pinned}
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
            onRename={() => {
              const s = menu.s;
              const next = window.prompt("Session name", s.title)?.trim();
              if (!next || next === s.title) return;
              patchSummary(s.id, { title: next });
              window.dispatchEvent(new CustomEvent("workshop:renamed", { detail: { id: s.id, title: next } }));
              patchSession(s.id, { title: next }).then(() => load()).catch(() => load());
            }}
            onChanged={load}
          />
        ) : null}

        {tab === "sessions" && (
          <section>
            {/* one row, one height */}
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <label className="flex h-8 w-56 items-center gap-1.5 rounded-md border border-zinc-800 px-2 text-[12px] text-zinc-400 focus-within:border-zinc-600">
                <Search className="h-3.5 w-3.5 shrink-0" />
                <input ref={findRef} value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search sessions (⌘K)" className="min-w-0 flex-1 bg-transparent text-zinc-100 outline-none placeholder:text-zinc-500" />
              </label>
              <div className="mr-auto flex flex-wrap items-center gap-1.5">
                {(["all", ...DOC_KINDS.map((k) => k.id).filter((k) => sessions.some((x) => x.kinds?.includes(k)))] as const).map((k) => {
                  const n = k === "all" ? sessions.length : sessions.filter((x) => x.kinds?.includes(k)).length;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setKindFilter(k)}
                      aria-pressed={kindFilter === k}
                      className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] ${kindFilter === k ? "border-zinc-600 bg-zinc-800 text-zinc-100" : "border-zinc-800 text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"}`}
                    >
                      {k === "all" ? null : <span className={`h-1.5 w-1.5 rounded-full ${KIND_DOT[k]}`} />}
                      {k === "all" ? "All" : DOC_KINDS.find((d) => d.id === k)!.label} · {n}
                    </button>
                  );
                })}
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                  className="h-8 rounded-md border border-zinc-800 bg-transparent px-2 text-[12px] text-zinc-400 outline-none hover:text-zinc-200"
                  aria-label="Sort sessions"
                >
                  <option value="recent">Sort: Recent</option>
                  <option value="type">Sort: Type</option>
                  <option value="status">Sort: Status</option>
                </select>
              </div>
              {notice && !picked.size && <span className="text-[12px] text-zinc-400">{notice}</span>}
              {picked.size > 0 && (
                <span data-keep-picked className="contents">
                  <button
                    type="button"
                    onClick={() => setPicked(new Set(visible.map((s) => s.id)))}
                    className="h-8 rounded-md px-2 text-[12px] text-zinc-400 hover:text-zinc-100"
                  >
                    Select all
                  </button>
                  <button type="button" onClick={() => setPicked(new Set())} title="Clear (Esc)" aria-label="Clear the selection" className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100">
                    <X className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" disabled={busy !== null} onClick={() => void sharePicked()} title="A share link for each, all copied; each session moves to In Production" className="flex h-8 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 text-[12px] text-zinc-100 hover:bg-zinc-800 disabled:opacity-50">
                    {busy === "share" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                    Share {picked.size}
                  </button>
                  <button type="button" disabled={busy !== null} onClick={() => void exportPicked()} title="Each as its own Obsidian note (a note with pictures as a zip with a folder); each session moves to In Production" className="flex h-8 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 text-[12px] text-zinc-100 hover:bg-zinc-800 disabled:opacity-50">
                    {busy === "export" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    Export {picked.size}
                  </button>
                </span>
              )}
              {/* hidden while rows are picked, so Share / Export take its place and nothing wraps */}
              {!picked.size && <button type="button" disabled={busy !== null} onClick={() => void newSession()} className={`${primary} h-8 py-0`}>
                {busy === "session" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                New session
              </button>}
            </div>
            {!sessionsKnown ? (
              <div aria-hidden className="flex flex-col gap-1.5">
                {Array.from({ length: 5 }, (_, i) => (
                  <span key={i} className="block h-[46px] rounded-lg border border-zinc-800/60 bg-zinc-900/30" />
                ))}
              </div>
            ) : sessions.length === 0 ? (
              <p className="py-10 text-center text-sm text-zinc-600">
                No sessions yet. Start one, search a topic, add the posts worth reading.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {(() => {
                  // Published sessions are wrapped up: folded under a line at the end
                  // live from the sidebar's summary: a reply running, or one finished that you haven't looked at
                  const live = (s: SessionRow) => {
                    const r = summaries?.find((x) => x.id === s.id);
                    return { working: !!r?.working, unseen: !!r?.ready && !r.working };
                  };
                  const shown = visible;
                  // pinned sessions first, in their own block (the sidebar's Pinned group)
                  const pinnedRows = shown.filter((s) => s.pinned);
                  const rest = shown.filter((s) => !s.pinned);
                  const done = rest.filter((s) => s.status === "published");
                  // the script is done (Ready) or handed off (In Production): nothing waits on you there
                  const making = rest.filter((s) => MAKING.includes(s.status ?? "draft"));
                  const shelved = rest.filter((s) => s.status === "shelved");
                  const fold = (label: string, list: SessionRow[], open: boolean, toggle: () => void, dim: string) =>
                    list.length > 0 && (
                      <>
                        <button
                          type="button"
                          onClick={toggle}
                          aria-expanded={open}
                          className="mt-3 flex items-center gap-3 rounded-md px-1 py-1 text-[12px] text-zinc-500 hover:text-zinc-300"
                        >
                          <span>
                            {label} ({list.length})
                          </span>
                          <span className="h-px flex-1 bg-zinc-800" />
                          <ChevronDown className={`h-3.5 w-3.5 ${open ? "rotate-180" : ""}`} />
                        </button>
                        {open && <div className={`flex flex-col gap-1.5 ${dim}`}>{list.map(row)}</div>}
                      </>
                    );
                  const row = (s: SessionRow) => (
                  <div
                    key={s.id}
                    data-keep-picked
                    // the whole row is the target: a
                    // Shift/⌘-click anywhere on it but its buttons picks it, and nothing on the row selects as text
                    className={`group flex select-none items-center gap-3 rounded-lg border px-3 py-2.5 ${picked.has(s.id) ? "border-violet-500/50 bg-violet-500/5" : "border-zinc-800 bg-zinc-900/50"}`}
                    onMouseDown={(e) => (e.shiftKey || e.metaKey || e.ctrlKey) && e.preventDefault()}
                    onClick={(e) => {
                      if ((e.target as Element).closest("button, select, input, a[target=_blank], [role=button], [role=combobox]")) return;
                      pickClick(e, s.id);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ s, x: e.clientX, y: e.clientY });
                    }}
                  >
                    {/* the type tile first, the name, and what the AI is doing; the counts were noise.
                        The link fills the row's height and left edge, so a plain click on its padding opens it too. */}
                    <Link
                      to={sessionPath(s.id)}
                      onClick={(e) => (e.shiftKey || e.metaKey || e.ctrlKey) && e.preventDefault()} // a pick, not a visit: the row picks it
                      className="-my-2.5 -ml-3 flex min-w-0 flex-1 items-center gap-2.5 self-stretch py-2.5 pl-3"
                    >
                      {(s.kinds?.length ? s.kinds : [undefined]).map((k, i) => (
                        <KindTile key={k ?? i} kind={k} />
                      ))}
                      <span className={`truncate text-sm ${live(s).unseen ? "font-semibold text-zinc-50" : "text-zinc-300"}`}>{s.title}</span>
                      {live(s).working || s.generating ? (
                        <span className="flex shrink-0 items-center gap-1 text-[11px] text-violet-300">
                          <Loader2 className="h-3 w-3 animate-spin" /> Working
                        </span>
                      ) : live(s).unseen ? (
                        <span className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-300" title="A reply finished that you haven't looked at">
                          <CircleCheck className="h-3.5 w-3.5" /> Done
                        </span>
                      ) : null}
                      <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-zinc-500">{timeAgo(s.updatedAt)}</span>
                    </Link>
                    <SessionPosted postings={postingsOfSession(s)} status={s.status} disabled={busy !== null} onChange={(posted) => void setPosted(s.id, posted)} />
                    <SessionStatusSelect
                      value={s.status}
                      disabled={busy !== null}
                      onChange={(status) => setStatus(s.id, status)}
                    />
                    <SharePopover
                      sessionId={s.id}
                      title={s.title}
                      onStatus={(status) => setSessions((rows) => rows.map((r) => (r.id === s.id ? { ...r, status } : r)))}
                      shared={!!s.shared}
                      onShared={(on) => setSessions((rows) => rows.map((r) => (r.id === s.id ? { ...r, shared: on } : r)))}
                      className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
                    />
                    {/* no Delete on the row: it's in the right-click menu */}
                  </div>
                  );
                  const main = rest.filter((s) => !done.includes(s) && !making.includes(s) && !shelved.includes(s));
                  order.current = [...pinnedRows, ...main, ...(showProduction ? making : []), ...(showPublished ? done : []), ...(showShelved ? shelved : [])].map((s) => s.id);
                  return (
                    <>
                      {pinnedRows.length > 0 && <p className="px-1 pb-1 text-[12px] text-zinc-500">Pinned ({pinnedRows.length})</p>}
                      {pinnedRows.map(row)}
                      {main.map(row)}
                      {fold("Ready & in production", making, showProduction, () => setShowProduction((v) => !v), "")}
                      {fold("Published", done, showPublished, () => setShowPublished((v) => !v), "opacity-75")}
                      {fold("Shelved", shelved, showShelved, () => setShowShelved((v) => !v), "opacity-60")}
                    </>
                  );
                })()}
              </div>
            )}
          </section>
        )}

        {tab === "projects" && <ProjectList />}

        {tab === "rules" && (
          <section>
            <p className={label}>Writing rules — they apply inside every framework</p>
            <p className="mb-3 text-[11px] text-zinc-500">
              Rules that are on go into every generation. Switch one off here to drop it by default, or untick it for a single run in the Generate panel.
            </p>
            <form
              className="mb-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!newRule.trim()) return;
                void run("rule", async () => {
                  await createRule({ text: newRule.trim() });
                  setNewRule("");
                });
              }}
            >
              <input
                value={newRule}
                onChange={(e) => setNewRule(e.target.value)}
                placeholder="New rule, as an instruction — e.g. Spell out numbers under a hundred."
                className="min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500"
              />
              <button type="submit" disabled={busy !== null || !newRule.trim()} className={primary}>
                {busy === "rule" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Add
              </button>
            </form>
            <div className="flex flex-col gap-1.5">
              {rules.map((r) => (
                <RuleRow
                  key={r.id}
                  rule={r}
                  busy={busy !== null}
                  onSave={(fields: Partial<RuleFields>) => void run(`rule:${r.id}`, () => patchRule(r.id, fields))}
                  onDelete={() => void run(`delr:${r.id}`, () => deleteRule(r.id))}
                />
              ))}
            </div>
          </section>
        )}

        {tab === "knowledge" && <KnowledgePanel />}

        {tab === "frameworks" && (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <p className={`${label} mb-0`}>Storytelling frameworks</p>
              <button type="button" disabled={busy !== null || editing === "new"} onClick={() => setEditing("new")} className={secondary}>
                <Plus className="h-3.5 w-3.5" /> New framework
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {editing === "new" && (
                <FrameworkForm busy={busy === "framework"} onSave={(f) => void saveFramework("new", f)} onCancel={() => setEditing(null)} />
              )}
              {frameworks.map((fw) =>
                editing === fw.id ? (
                  <FrameworkForm key={fw.id} initial={fw} busy={busy === "framework"} onSave={(f) => void saveFramework(fw.id, f)} onCancel={() => setEditing(null)} />
                ) : (
                  <div key={fw.id} className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-zinc-100">
                        {fw.name}
                        <span className="ml-2 rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-400">
                          {FRAMEWORK_ROLES.find((r) => r.id === (fw.role ?? "narrative"))?.label ?? fw.role}
                        </span>
                        {fw.seedKey ? <span className="ml-2 text-[10px] text-zinc-600">starter</span> : null}
                      </p>
                      {fw.summary ? <p className="mt-0.5 text-[11px] text-zinc-500">{fw.summary}</p> : null}
                      <ol className="mt-1 list-decimal pl-4 text-[11px] text-zinc-400">
                        {fw.steps.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ol>
                      {fw.whenToUse ? <p className="mt-1 text-[11px] text-zinc-600">Best for: {fw.whenToUse}</p> : null}
                      {fw.pairsWith ? <p className="mt-0.5 text-[11px] text-zinc-600">Pairs with: {fw.pairsWith}</p> : null}
                    </div>
                    {fw.owner === me?.username && (
                      <PublishButton
                        item={{ kind: "framework", id: fw.id, defaultName: fw.name, defaultDescription: fw.summary }}
                        className={secondary}
                      />
                    )}
                    <button type="button" onClick={() => setEditing(fw.id)} className={secondary} disabled={busy !== null}>
                      <Pencil className="h-3 w-3" /> Edit
                    </button>
                    <ConfirmButton
                      label="Delete"
                      confirmLabel="Click again"
                      disabled={busy !== null}
                      onConfirm={() => run(`delf:${fw.id}`, () => deleteFramework(fw.id))}
                      className="rounded-md px-2 py-1.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-red-300 disabled:opacity-50"
                      armedClassName="!bg-red-500/10 !text-red-200"
                    />
                  </div>
                ),
              )}
            </div>
          </section>
        )}
      </div>
      </div>
      </div>
    </div>
  );
}

/** The sessions the list shows: one type (or all), newest first, or grouped by type or by status (newest first within). */
export type SessionSort = "recent" | "type" | "status";

export function shownSessions(rows: SessionRow[], kind: PieceKind | "all", sortBy: SessionSort): SessionRow[] {
  const typeRank = (r: SessionRow) => Math.min(...(r.kinds ?? []).map((k) => DOC_KINDS.findIndex((d) => d.id === k)), DOC_KINDS.length);
  const statusRank = (r: SessionRow) => SESSION_STATUSES.findIndex((x) => x.id === (r.status ?? "draft"));
  return rows
    .filter((r) => kind === "all" || r.kinds?.includes(kind))
    .sort((a, b) => (sortBy === "type" ? typeRank(a) - typeRank(b) : sortBy === "status" ? statusRank(a) - statusRank(b) : 0) || b.updatedAt - a.updatedAt);
}
