import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Check, ChevronDown, CircleCheck, ListFilter, Loader2, PanelLeftClose, PanelLeftOpen, Search, SquarePen } from "lucide-react";
import { DOC_KINDS, createSession, patchSession, sessionPath, type PieceKind } from "@/lib/workshop";
import { groupSummaries, patchSummary, refreshSummaries, useSessionSummaries, type SessionSummary } from "@/lib/workshop-summary";
import { KIND_DOT } from "./DocumentTabs";
import { KindTile } from "./KindTile";
import { SessionMenu } from "./SessionMenu";
import { storedStatusBars } from "@/lib/settings";
import { useWorkspace } from "@/lib/workspace";
import { useMe } from "@/lib/auth";
import { putCached, readCached } from "@/lib/local-cache";

/**
 * The Workshop's session list beside every Workshop screen: what's being
 * written, what's waiting for you, then the rest by status. ⌘K finds a session by name, ⌘1–9 open the first nine.
 */

const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const STATUS_BAR: Record<string, string> = {
  draft: "bg-zinc-600",
  writing: "bg-violet-400",
  ready: "bg-emerald-400",
  production: "bg-amber-400",
  editing: "bg-amber-400",
  toPost: "bg-emerald-300",
  published: "bg-violet-400",
  shelved: "bg-zinc-700",
};

function Row({ r, active, n }: { r: SessionSummary; active: boolean; n?: number }) {
  // Rows: a reply you haven't looked at reads bright with a green Done; the rest stay quiet
  const unseen = r.ready && !r.working;
  // double-click renames in place
  const [editing, setEditing] = useState(false);
  // right-click: the session menu (Pin, Rename, Regenerate title, Mark unread, Copy, Duplicate, Shelve, Delete)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={r.title}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.currentTarget.value = r.title;
            e.currentTarget.blur();
          }
        }}
        onBlur={(e) => {
          setEditing(false);
          const t = e.currentTarget.value.trim() || "Untitled session";
          if (t === r.title) return;
          patchSummary(r.id, { title: t });
          window.dispatchEvent(new CustomEvent("workshop:renamed", { detail: { id: r.id, title: t } }));
          patchSession(r.id, { title: t }).catch(() => refreshSummaries());
        }}
        className="w-full rounded-md border border-violet-500/60 bg-zinc-900 px-2 py-1 text-[13px] text-zinc-50 outline-none"
        aria-label="Session name"
      />
    );
  }
  return (
    <>
    <Link
      to={sessionPath(r.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        setEditing(true);
      }}
      className={`group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${active ? "bg-zinc-800 text-zinc-50" : unseen ? "text-zinc-50 hover:bg-zinc-800/60" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100"}`}
      title={`${r.title}${n ? `  ⌘${n}` : ""} · double-click to rename`}
    >
      {/* the status at a glance, only when switched on in Settings → General */}
      {storedStatusBars() ? <span className={`absolute inset-y-1.5 left-0 w-[3px] rounded-full ${STATUS_BAR[r.status] ?? STATUS_BAR.draft}`} title={r.status} aria-hidden /> : null}
      <KindTile kind={r.kinds[0] as PieceKind | undefined} />
      <span className={`min-w-0 flex-1 truncate ${unseen ? "font-medium" : ""}`}>{r.title || "Untitled session"}</span>
      {r.working ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-violet-300">
          <Loader2 className="h-3 w-3 animate-spin" /> Working
        </span>
      ) : unseen ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-300" title="A reply finished that you haven't looked at">
          <CircleCheck className="h-3.5 w-3.5" /> Done
        </span>
      ) : (
        <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">{ago(r.updatedAt)}</span>
      )}
    </Link>
    {menu ? (
      <SessionMenu id={r.id} title={r.title} status={r.status} pinned={r.pinned} open={active} x={menu.x} y={menu.y} onClose={() => setMenu(null)} onRename={() => setEditing(true)} />
    ) : null}
    </>
  );
}

function Group({ label, rows, active, numbers, foldKey, foldDefault }: { label: string; rows: SessionSummary[]; active?: string; numbers: Map<string, number>; foldKey?: string; foldDefault?: boolean }) {
  const [open, setOpen] = useState(() => (foldKey ? (localStorage.getItem(foldKey) ?? (foldDefault ? "open" : "closed")) === "open" : true));
  if (!rows.length) return null;
  return (
    <div className="mt-3 first:mt-0">
      {foldKey ? (
        <button
          type="button"
          onClick={() => {
            localStorage.setItem(foldKey, open ? "closed" : "open");
            setOpen(!open);
          }}
          className="flex w-full items-center gap-1 px-2 pb-1 text-[11px] font-medium text-zinc-500 hover:text-zinc-300"
          aria-expanded={open}
        >
          {label} ({rows.length}) <ChevronDown className={`ml-auto h-3 w-3 ${open ? "rotate-180" : ""}`} />
        </button>
      ) : (
        <p className="px-2 pb-1 text-[11px] font-medium text-zinc-500">{label}</p>
      )}
      {open && rows.map((r) => <Row key={r.id} r={r} active={r.id === active} n={numbers.get(r.id)} />)}
    </div>
  );
}

export function WorkshopSidebar({ activeId, title }: { activeId?: string; title: string }) {
  const live = useSessionSummaries();
  const navigate = useNavigate();
  // the rows saved on this device paint at once; the live poll replaces them (saved without "working": no stale spinner)
  const me = useMe();
  const projectId = useWorkspace((s) => s.currentProjectId);
  const summaryKey = `workshop/summary?p=${projectId ?? ""}`;
  const all = live ?? readCached<SessionSummary[]>(me?.username, summaryKey);
  const lastSaved = useRef("");
  useEffect(() => {
    if (!live || !me?.username) return;
    const next = live.map((r) => ({ ...r, working: false }));
    const raw = JSON.stringify(next);
    if (raw === lastSaved.current) return;
    lastSaved.current = raw;
    putCached(me.username, summaryKey, next);
  }, [live, me?.username, summaryKey]);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("workshop:sidebar") === "closed");
  const [finding, setFinding] = useState(false);
  const [making, setMaking] = useState(false);
  // The sidebar top: search as you type, a filter menu (type, sort), new session
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<PieceKind | "all">(() => (localStorage.getItem("workshop:side-kind") as PieceKind | null) ?? "all");
  const [sortBy, setSortBy] = useState<"recent" | "name">(() => (localStorage.getItem("workshop:side-sort") === "name" ? "name" : "recent"));
  const [filterOpen, setFilterOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    localStorage.setItem("workshop:side-kind", kind);
    localStorage.setItem("workshop:side-sort", sortBy);
  }, [kind, sortBy]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = (all ?? []).filter((r) => (kind === "all" || r.kinds.includes(kind)) && (!needle || r.title.toLowerCase().includes(needle)));
    return sortBy === "name" ? [...rows].sort((a, b) => a.title.localeCompare(b.title)) : rows;
  }, [all, q, kind, sortBy]);
  const g = useMemo(() => groupSummaries(filtered, sortBy === "name"), [filtered, sortBy]);
  // switching project shows that project's sessions at once
  useEffect(() => void refreshSummaries(), [projectId]);
  // ⌘1–9: the rows in the order they show, folded groups included
  const order = useMemo(() => [...g.pinned, ...g.writing, ...g.making, ...g.published, ...g.shelved], [g]);
  const numbers = useMemo(() => new Map(order.slice(0, 9).map((r, i) => [r.id, i + 1])), [order]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key === "k") {
        e.preventDefault();
        // the sidebar's search when it's open, else the finder
        if (searchRef.current) searchRef.current.focus();
        else setFinding(true);
      } else if (/^[1-9]$/.test(e.key) && order[Number(e.key) - 1]) {
        e.preventDefault();
        navigate(sessionPath(order[Number(e.key) - 1]!.id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, navigate]);

  const { waiting, working } = useWorkshopTitle(title, activeId);

  if (collapsed) {
    return (
      <div className="flex shrink-0 flex-col items-center gap-2 pb-10 pl-2 pt-2">
        <button type="button" onClick={() => (localStorage.setItem("workshop:sidebar", "open"), setCollapsed(false))} className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Show sessions" aria-label="Show sessions">
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        {working ? <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" aria-label={`${working} replies being written`} /> : null}
        {waiting ? <span className="rounded-full bg-violet-500 px-1.5 text-[10px] font-medium text-white">{waiting}</span> : null}
        {finding ? <Finder rows={order} onClose={() => setFinding(false)} /> : null}
      </div>
    );
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col pb-10 pl-2 pt-2" aria-label="Sessions">
      <div className="flex items-center gap-0.5 px-1 pb-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-[13px] text-zinc-500 focus-within:bg-zinc-800/60" title="Search sessions (⌘K)">
          <Search className="h-4 w-4 shrink-0" />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQ("");
                e.currentTarget.blur();
              }
              if (e.key === "Enter" && order[0]) navigate(sessionPath(order[0].id));
            }}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent text-zinc-100 outline-none placeholder:text-zinc-500"
          />
        </label>
        <span className="relative">
          <button
            type="button"
            onClick={() => setFilterOpen((o) => !o)}
            className={`flex h-8 w-8 items-center justify-center rounded-md hover:bg-zinc-800 hover:text-zinc-100 ${kind !== "all" || sortBy !== "recent" ? "text-violet-300" : "text-zinc-500"}`}
            title="Filter and sort"
            aria-label="Filter and sort"
            aria-expanded={filterOpen}
          >
            <ListFilter className="h-4 w-4" />
          </button>
          {filterOpen ? (
            <div className="absolute left-0 top-full z-40 mt-1 w-48 rounded-lg border border-zinc-700 bg-zinc-900 p-1 text-[12px] shadow-xl" onMouseLeave={() => setFilterOpen(false)}>
              <p className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">Type</p>
              {(["all", ...DOC_KINDS.map((d) => d.id)] as const).map((k) => (
                <button key={k} type="button" onClick={() => setKind(k)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-zinc-300 hover:bg-zinc-800">
                  {k === "all" ? <span className="h-1.5 w-1.5" /> : <span className={`h-1.5 w-1.5 rounded-full ${KIND_DOT[k]}`} />}
                  {k === "all" ? "All" : DOC_KINDS.find((d) => d.id === k)!.label}
                  {kind === k ? <Check className="ml-auto h-3.5 w-3.5 text-violet-300" /> : null}
                </button>
              ))}
              <p className="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-zinc-500">Sort</p>
              {(
                [
                  ["recent", "Recent"],
                  ["name", "Name"],
                ] as const
              ).map(([v, label]) => (
                <button key={v} type="button" onClick={() => setSortBy(v)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-zinc-300 hover:bg-zinc-800">
                  {label}
                  {sortBy === v ? <Check className="ml-auto h-3.5 w-3.5 text-violet-300" /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </span>
        <button
          type="button"
          disabled={making}
          onClick={() => {
            setMaking(true);
            createSession({})
              .then((s) => {
                void refreshSummaries();
                navigate(sessionPath(s.id));
              })
              .finally(() => setMaking(false));
          }}
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
          title="New session"
          aria-label="New session"
        >
          {making ? <Loader2 className="h-4 w-4 animate-spin" /> : <SquarePen className="h-4 w-4" />}
        </button>
        <button type="button" onClick={() => (localStorage.setItem("workshop:sidebar", "closed"), setCollapsed(true))} className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Hide sessions" aria-label="Hide sessions">
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto pr-1">
        {all === null ? (
          // nothing saved on this device yet: the rows' places in quiet blocks until the list lands
          <div aria-hidden className="flex flex-col gap-0.5 px-1 pt-1">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <span key={i} className="block h-8 rounded-md bg-zinc-800/40" />
            ))}
          </div>
        ) : null}
        <Group label="Pinned" rows={g.pinned} active={activeId} numbers={numbers} />
        <Group label="Ideas & writing" rows={g.writing} active={activeId} numbers={numbers} />
        <Group label="Ready & in production" rows={g.making} active={activeId} numbers={numbers} foldKey="workshop:side-production" foldDefault />
        <Group label="Published" rows={g.published} active={activeId} numbers={numbers} foldKey="workshop:side-published" />
        <Group label="Shelved" rows={g.shelved} active={activeId} numbers={numbers} foldKey="workshop:side-shelved" />
      </nav>
      {finding ? <Finder rows={order} onClose={() => setFinding(false)} /> : null}
    </aside>
  );
}

/** ⌘K: type part of a name, ↑↓, Enter. */
function Finder({ rows, onClose }: { rows: SessionSummary[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const navigate = useNavigate();
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => box.current?.focus(), []);
  const hits = rows.filter((r) => r.title.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 12);
  const go = (r?: SessionSummary) => {
    if (!r) return;
    onClose();
    navigate(sessionPath(r.id));
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-[min(32rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <input
          ref={box}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setAt((i) => (e.key === "ArrowDown" ? Math.min(i + 1, hits.length - 1) : Math.max(i - 1, 0)));
            }
            else if (e.key === "Enter") go(hits[at]);
          }}
          placeholder="Find a session…"
          className="w-full border-b border-zinc-800 bg-transparent px-4 py-3 text-[15px] text-zinc-100 outline-none placeholder:text-zinc-500"
        />
        <div className="max-h-80 overflow-y-auto p-1.5">
          {hits.length ? (
            hits.map((r, i) => (
              <button
                key={r.id}
                type="button"
                onMouseEnter={() => setAt(i)}
                onClick={() => go(r)}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] ${i === at ? "bg-zinc-800 text-zinc-50" : "text-zinc-300"}`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.kinds[0] ? KIND_DOT[r.kinds[0]] : "bg-zinc-600"}`} />
                <span className="min-w-0 flex-1 truncate">{r.title || "Untitled session"}</span>
                {r.working ? <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" /> : r.ready ? <span className="h-2 w-2 rounded-full bg-violet-400" /> : null}
              </button>
            ))
          ) : (
            <p className="px-3 py-4 text-center text-[12px] text-zinc-500">No session by that name.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The tab's title and the Mac app's Dock carry the count of replies waiting for you (the open session aside), on every
 * Workshop screen, with or without the sidebar.
 */
export function useWorkshopTitle(title: string, activeId?: string) {
  const all = useSessionSummaries();
  const waiting = (all ?? []).filter((r) => r.ready && !r.working && r.id !== activeId).length;
  const working = (all ?? []).filter((r) => r.working).length;
  useEffect(() => {
    document.title = `${working ? "● " : ""}${waiting ? `(${waiting}) ` : ""}${title}`;
    dockBadge(waiting ? String(waiting) : "");
  }, [waiting, working, title]);
  useEffect(() => () => dockBadge(""), []);
  return { waiting, working };
}

const dockBadge = (v: string) => (window as unknown as { webkit?: { messageHandlers?: { badge?: { postMessage: (v: string) => void } } } }).webkit?.messageHandlers?.badge?.postMessage(v);
