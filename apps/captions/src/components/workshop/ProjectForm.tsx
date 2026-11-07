import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { timeAgo } from "@/lib/exports";
import {
  addAccount,
  analyzerHome,
  getInstagramAvailability,
  listAccounts,
  mineAccount,
  accountCatalogReady,
  fmtCount,
  getAccount,
  type InstagramAccount,
  type InstagramAvailability,
} from "@/lib/instagram";
import {
  PROJECT_NOTES_MAX,
  draftProjectNotes,
  foldProjectInstructions,
  listFrameworks,
  listRules,
  listSources,
  type KnowledgeSource,
  type ProjectFields,
  type WorkshopFramework,
  type WorkshopProject,
  type WorkshopRule,
} from "@/lib/workshop";
import { PROJECT_COLORS, projectColor, useWorkspace, type ProjectColor } from "@/lib/workspace";

const EMPTY: ProjectFields = { name: "", audience: "", voice: "", cta: "", notes: "", accountId: null };

const input =
  "w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500";

function fieldsFrom(initial?: WorkshopProject): ProjectFields {
  // knowledge lives in the account's Knowledge now (sources); the form never sends the old context files back
  const { knowledge: _old, ...cur } = initial ? { ...EMPTY, ...initial, accountId: initial.accountId ?? null } : EMPTY;
  return { ...cur, notes: foldProjectInstructions(cur), audience: "", voice: "", cta: "" };
}

function sameHandle(raw: string, username: string): boolean {
  return raw.trim().replace(/^@/, "").toLowerCase() === username.toLowerCase();
}

function withAccount(list: InstagramAccount[], acc: InstagramAccount): InstagramAccount[] {
  const rest = list.filter((a) => a.id !== acc.id);
  return [acc, ...(acc.mine ? rest.map((a) => ({ ...a, mine: undefined })) : rest)];
}

/** Brand profile: instructions always in the prompt; which of the account's knowledge, frameworks and rules it uses. */
export function ProjectForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial?: WorkshopProject;
  busy: boolean;
  onSave: (fields: ProjectFields) => void | Promise<unknown>;
  /** Absent = no Cancel (the first-run setup, where a project is required). */
  onCancel?: () => void;
}) {
  const [f, setF] = useState<ProjectFields>(() => fieldsFrom(initial));
  const [handle, setHandle] = useState("");
  const [accounts, setAccounts] = useState<InstagramAccount[]>([]);
  const [avail, setAvail] = useState<InstagramAvailability | null>(null);
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frameworks, setFrameworks] = useState<WorkshopFramework[]>([]);
  const [rules, setRules] = useState<WorkshopRule[]>([]);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [drafting, setDrafting] = useState(false);
  const alive = useRef(true);
  const set = (k: "name" | "notes") => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }));
  const locked = busy || pulling || drafting;
  const off = f.off ?? [];
  const toggleOff = (id: string) =>
    setF((cur) => {
      const now = cur.off ?? [];
      return { ...cur, off: now.includes(id) ? now.filter((x) => x !== id) : [...now, id] };
    });
  const draft = () => {
    if (!linked) return;
    setError(null);
    setDrafting(true);
    draftProjectNotes(linked.id, f.name)
      .then(({ notes }) => alive.current && setF((cur) => ({ ...cur, notes: cur.notes.trim() ? `${cur.notes.trim()}\n\n${notes}` : notes })))
      .catch((err) => alive.current && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => alive.current && setDrafting(false));
  };
  const linked = accounts.find((a) => a.id === f.accountId);
  const canSync = accountCatalogReady(avail, true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    listFrameworks().then(setFrameworks).catch(() => {});
    listRules().then(setRules).catch(() => {});
    listSources().then(setSources).catch(() => {});
  }, []);
  // another project's own sources never show here; a new project sees the account-wide ones
  const knowledge = sources.filter((s) => !s.projectId || s.projectId === initial?.id);

  useEffect(() => {
    Promise.all([listAccounts("", { projectId: null }), getInstagramAvailability()])
      .then(([list, nextAvail]) => {
        setAccounts(list);
        setAvail(nextAvail);
        const found = initial?.accountId ? list.find((a) => a.id === initial.accountId) : undefined;
        // a new project starts with "my account" only when it's the first one: a second brand has its own Instagram
        const acc = found ?? (!initial && !useWorkspace.getState().projects.length ? mineAccount(list) : undefined);
        if (!acc) return;
        setHandle(`@${acc.username}`);
        setF((cur) => ({ ...cur, accountId: acc.id }));
      })
      .catch(() => {});
  }, [initial]);

  const watch = (id: string) => {
    let n = 0;
    const tick = () => {
      if (!alive.current) return;
      getAccount(id)
        .then((acc) => {
          if (!alive.current) return;
          setAccounts((list) => withAccount(list, acc));
          if (acc.status === "processing" && n++ < 90) window.setTimeout(tick, 1000);
        })
        .catch(() => {});
    };
    window.setTimeout(tick, 800);
  };

  const connect = async (runNow: boolean) => {
    const raw = handle.trim();
    if (!raw) throw new Error("Enter @yourhandle");
    // "My account" is the one Instagram login (Meta Graph) and stays with its brand: another project's handle is
    // linked to that project, not made "mine"
    const cur = mineAccount(accounts);
    const mine = !cur || sameHandle(raw, cur.username) || initial?.accountId === cur.id;
    const acc = await addAccount(raw, { mine, run: runNow && canSync ? "now" : "later" });
    setHandle(`@${acc.username}`);
    setF((cur) => ({ ...cur, accountId: acc.id }));
    setAccounts((list) => withAccount(list, acc));
    if (acc.status === "processing") watch(acc.id);
    return acc.id;
  };

  const sync = () => {
    setError(null);
    setPulling(true);
    void connect(true)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPulling(false));
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setPulling(true);
        const raw = handle.trim();
        const skipPull = Boolean(linked && raw && sameHandle(raw, linked.username));
        // no handle: a project without Instagram (a creator on other platforms is not stuck in setup)
        void (!raw ? Promise.resolve(null) : skipPull ? Promise.resolve(linked!.id) : connect(true))
          .then((accountId) => Promise.resolve(onSave({ ...f, accountId, audience: "", voice: "", cta: "" })))
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setPulling(false));
      }}
    >
      <label className="text-[11px] text-zinc-400">
        Name
        <input autoFocus value={f.name} onChange={set("name")} placeholder="Tiny Acrobatics" className={`${input} mt-1`} />
      </label>
      <div>
        <p className="text-[11px] text-zinc-400">Colour</p>
        <div className="mt-1 flex gap-1.5" role="radiogroup" aria-label="Project colour">
          {(Object.keys(PROJECT_COLORS) as ProjectColor[]).map((c) => {
            const on = projectColor({ id: initial?.id ?? "new", color: f.color }) === c;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={c}
                title={c}
                onClick={() => setF((cur) => ({ ...cur, color: c }))}
                className={`h-5 w-5 rounded-full ${PROJECT_COLORS[c].dot} ${on ? "ring-2 ring-white/80 ring-offset-2 ring-offset-zinc-900" : "opacity-60 hover:opacity-100"}`}
              />
            );
          })}
        </div>
      </div>
      <div>
        <p className="text-[11px] text-zinc-400">My Instagram</p>
        <div className="mt-1 flex gap-2">
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="@yourhandle"
            disabled={locked}
            spellCheck={false}
            className={`${input} mt-0`}
          />
          <button
            type="button"
            disabled={locked || !handle.trim() || !canSync}
            onClick={sync}
            title="Refresh profile, every post, insights and comments from Graph, plus the public grid"
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
          >
            {pulling || linked?.status === "processing" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Sync
          </button>
        </div>
        {linked ? (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-500">
            <span className="text-violet-300/80">Analyzer · @{linked.username}</span>
            {linked.counts.fetchedAt > 0 ? <span>{fmtCount(linked.counts.followers)} followers</span> : null}
            <span>{linked.catalogCount ?? 0} listed</span>
            {linked.lastCatalogAt ? <span>synced {timeAgo(linked.lastCatalogAt)}</span> : <span>not synced yet</span>}
            {linked.status === "processing" ? <span className="text-violet-300">syncing…</span> : null}
            <Link to={`${analyzerHome()}/accounts/${linked.id}`} className="text-violet-400 hover:underline">
              Open
            </Link>
          </p>
        ) : null}
        <p className="mt-0.5 text-[10px] text-zinc-600">
          {canSync
            ? "Sync is this project's Instagram in Analyzer: Meta Graph (private insights, comments, trial reels) plus the public grid."
            : "Links the handle as your account. To read its posts, log in with Instagram or add your own Apify key (Settings → Connectors), then Sync."}
        </p>
        {error ? <p className="mt-0.5 text-[10px] text-red-400">{error}</p> : null}
      </div>
      <label className="text-[11px] text-zinc-400">
        <span className="flex items-center justify-between">
          Instructions
          {linked ? (
            <button
              type="button"
              onClick={draft}
              disabled={locked || !(linked.catalogCount ?? 0)}
              title={linked.catalogCount ? "Draft the facts about this brand from its bio and posts, for you to rewrite" : "Sync the Instagram first"}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-violet-300 hover:bg-zinc-800 disabled:opacity-40"
            >
              {drafting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              Draft from my posts
            </button>
          ) : null}
        </span>
        <textarea
          value={f.notes}
          onChange={set("notes")}
          maxLength={PROJECT_NOTES_MAX}
          placeholder="Who you write for, how you sound, what never to say."
          // grows with the text: one scroll for the window, not a second one inside the box
          className={`${input} mt-1 min-h-28 resize-none [field-sizing:content]`}
        />
        <span className="mt-0.5 block text-[10px] text-zinc-600">
          {f.notes.length}/{PROJECT_NOTES_MAX} — always in the prompt, so keep it short.
        </span>
      </label>
      {knowledge.length || frameworks.length || rules.length ? (
        <div>
          <p className="text-[11px] text-zinc-400">Knowledge, frameworks and rules</p>
          <p className="mb-1.5 text-[10px] text-zinc-600">
            All of yours are on in every project. Switch off what this one shouldn't use. Add knowledge in the Workshop's Knowledge tab.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {[...knowledge, ...frameworks, ...rules].map((x) => {
              const on = !off.includes(x.id);
              return (
                <button
                  key={x.id}
                  type="button"
                  aria-pressed={on}
                  disabled={locked}
                  onClick={() => toggleOff(x.id)}
                  title={on ? "On for this project: click to switch off" : "Off for this project: click to switch on"}
                  className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? "border-violet-500/50 bg-violet-500/10 text-zinc-100" : "border-zinc-800 text-zinc-600 line-through"}`}
                >
                  {x.name}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {/* Cancel / Save stay in view at the bottom while the form scrolls */}
      <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex justify-end gap-2 rounded-b-xl border-t border-zinc-800 bg-zinc-900/95 px-4 py-3 backdrop-blur">
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={locked || f.name.trim().length === 0}
          className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {(busy || pulling) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {initial ? "Save" : "Create project"}
        </button>
      </div>
    </form>
  );
}
