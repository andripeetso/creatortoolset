import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  ArrowLeft,
  ScanSearch,
  Link2,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { UserMenu } from "@/components/UserMenu";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import { DesktopHint } from "@/components/mobile/DesktopHint";
import { MobileAnalyzerLibrary } from "@/components/mobile/MobileAnalyzerLibrary";
import { AccountStatsCard } from "@/components/instagram/AccountStats";
import { canUse, useAuth, useMe } from "@/lib/auth";
import { toolsetHomePath } from "@/lib/mobile";
import { useWorkspace } from "@/lib/workspace";
import { KNOWHOW_CHIP } from "@/components/instagram/IdeaMark";
import {
  DEFAULT_RECIPE,
  KNOWHOW,
  SAVED_FOR,
  addAccount,
  analyzerHome,
  getInstagramAvailability,
  ingestPosts,
  instagramProfilesFromText,
  instagramUrlsFromText,
  isProcessing,
  listAccounts,
  listPosts,
  shareSheetText,
  toggleSavedFor,
  effectiveSavedFor,
  type InstagramAccount,
  type InstagramAvailability,
  type InstagramPost,
  type RunWhen,
  type SavedFor,
} from "@/lib/instagram";

/** Survives React Strict Mode remount so a share-sheet handoff isn't ingested twice. */
const ingestedShares = new Set<string>();

export default function MobileInstagramPage() {
  const home = toolsetHomePath();
  const base = analyzerHome();
  const me = useMe();
  const required = useAuth((s) => s.required);
  const allowed = canUse(me, "instagram");
  const currentProjectId = useWorkspace((s) => s.currentProjectId);

  const [sharePrefill] = useState(() => {
    const text = shareSheetText(window.location.search);
    if (text && window.location.search) {
      window.history.replaceState(null, "", base);
    }
    return text;
  });
  const [value, setValue] = useState(sharePrefill);
  const [posts, setPosts] = useState<InstagramPost[]>([]);
  const [accounts, setAccounts] = useState<InstagramAccount[]>([]);
  const [avail, setAvail] = useState<InstagramAvailability | null>(null);
  const [busy, setBusy] = useState<RunWhen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedFor, setSavedFor] = useState<SavedFor[]>(["content"]);
  const [knowhow, setKnowhow] = useState(false);

  const refresh = useCallback(() => {
    listPosts({ shelf: "all" })
      .then(setPosts)
      .catch(() => {});
    listAccounts()
      .then((list) => setAccounts(list.slice(0, 8)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!allowed) return;
    refresh();
    getInstagramAvailability()
      .then(setAvail)
      .catch(() => {});
  }, [allowed, currentProjectId, refresh]);

  const anyProcessing =
    posts.some(isProcessing) || accounts.some((a) => a.status === "processing");
  useEffect(() => {
    if (!allowed || !anyProcessing) return;
    const t = window.setInterval(refresh, 800);
    return () => window.clearInterval(t);
  }, [allowed, anyProcessing, refresh]);

  const crawlNow = Boolean(avail?.available);
  const urls = instagramUrlsFromText(value);
  const profiles = instagramProfilesFromText(value);
  const found = urls.length + profiles.length;

  const submit = async (raw: string, run: RunWhen) => {
    const text = raw.trim();
    if (!text || busy) return;
    const list = instagramUrlsFromText(text);
    const handles = instagramProfilesFromText(text);
    if (!list.length && !handles.length) {
      setError("Paste a post or reel link, a profile URL, or @username");
      return;
    }
    setBusy(run);
    setError(null);
    const notes: string[] = [];
    try {
      for (const profile of handles) {
        try {
          const acc = await addAccount(profile, { run });
          setAccounts((cur) => [acc, ...cur.filter((a) => a.id !== acc.id)].slice(0, 8));
        } catch (e) {
          notes.push(e instanceof Error ? e.message : String(e));
        }
      }
      if (list.length) {
        const { posts: next, errors } = await ingestPosts(list, {
          recipe: DEFAULT_RECIPE,
          run,
          savedFor,
          knowhow,
        });
        if (next.length) {
          setPosts((cur) => {
            const seen = new Set(next.map((p) => p.id));
            return [...next, ...cur.filter((p) => !seen.has(p.id))];
          });
        }
        if (!next.length && errors[0]) notes.push(errors[0].error);
        else if (errors.length) notes.push(`${errors.length} failed: ${errors[0].error}`);
      }
      setValue("");
      if (notes.length) setError(notes[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!sharePrefill || !avail) return;
    if (ingestedShares.has(sharePrefill)) return;
    const has =
      instagramUrlsFromText(sharePrefill).length +
      instagramProfilesFromText(sharePrefill).length;
    if (!has) return;
    ingestedShares.add(sharePrefill);
    void submit(sharePrefill, avail.available ? "now" : "later");
    // submit is recreated each render; the Set is the guard
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharePrefill, avail]);

  const run: RunWhen = crawlNow ? "now" : "later";

  return (
    <div className="relative flex min-h-dvh flex-col bg-[#0b0b10] px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(3.5rem,calc(env(safe-area-inset-top)+2.75rem))] text-zinc-200">
      <Link
        to={home}
        className="absolute left-3 top-[max(0.75rem,env(safe-area-inset-top))] flex items-center gap-1 rounded-md px-2 py-2 text-sm text-zinc-500 active:bg-zinc-900 active:text-zinc-200"
      >
        <ArrowLeft className="h-4 w-4" /> Tools
      </Link>
      <div className="absolute right-2 top-[max(0.5rem,env(safe-area-inset-top))] flex items-center gap-1">
        {me ? (
          <>
            <ProjectSwitcher />
            <UserMenu />
          </>
        ) : required ? (
          <Link to={home} className="rounded-md px-2 py-2 text-sm text-zinc-500">
            Sign in
          </Link>
        ) : null}
      </div>

      <div className="mx-auto flex w-full max-w-md flex-col gap-5">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-600">
            <ScanSearch className="h-6 w-6 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Content Analyzer</h1>
            <p className="text-sm text-zinc-500">Paste links from your phone</p>
          </div>
        </div>

        <DesktopHint>
          Full Analyzer is on your desktop — ranking, stacks, the lot. Drop links here and they crawl in the background.
        </DesktopHint>

        <div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 focus-within:border-violet-500">
            <div className="flex items-start gap-2">
              <Link2 className="mt-2.5 h-4 w-4 shrink-0 text-zinc-500" />
              <textarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={!!busy}
                placeholder="Paste post or reel links, a profile URL, or @username"
                rows={4}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="min-h-[6.5rem] min-w-0 flex-1 resize-none bg-transparent py-2 text-base text-zinc-100 outline-none placeholder:text-zinc-600 disabled:opacity-60"
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-zinc-800/80 pt-2">
              <span className="mr-auto text-[11px] text-zinc-600">Kept for</span>
              {SAVED_FOR.map((s) => {
                const on = !knowhow && effectiveSavedFor(savedFor).includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    title={s.hint}
                    aria-pressed={on}
                    onClick={() => {
                      if (knowhow) setSavedFor([s.id]);
                      else setSavedFor((cur) => toggleSavedFor(cur, s.id));
                      setKnowhow(false);
                    }}
                    className={`min-h-8 rounded-md border px-2.5 text-[12px] ${
                      on
                        ? s.id === "format"
                          ? "border-sky-500/50 bg-sky-500/15 text-sky-200"
                          : "border-violet-500/50 bg-violet-500/15 text-violet-200"
                        : "border-zinc-800 text-zinc-500"
                    }`}
                  >
                    {s.label}
                  </button>
                );
              })}
              <button
                type="button"
                title={KNOWHOW.hint}
                aria-pressed={knowhow}
                onClick={() => setKnowhow((on) => !on)}
                className={`min-h-8 rounded-md border px-2.5 text-[12px] ${KNOWHOW_CHIP(knowhow)}`}
              >
                {KNOWHOW.label}
              </button>
            </div>
            <div className="mt-2 flex items-center justify-end gap-2 border-t border-zinc-800/80 pt-2">
              {found > 1 && (
                <span className="mr-auto text-[11px] text-zinc-500">
                  {urls.length ? `${urls.length} post${urls.length === 1 ? "" : "s"}` : ""}
                  {urls.length && profiles.length ? " · " : ""}
                  {profiles.length
                    ? `${profiles.length} account${profiles.length === 1 ? "" : "s"}`
                    : ""}
                </span>
              )}
              <button
                type="button"
                disabled={!!busy || !value.trim()}
                onClick={() => void submit(value, run)}
                className="flex min-h-11 items-center gap-1.5 rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white active:bg-violet-500 disabled:opacity-50"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {crawlNow ? "Crawl" : "Save for desktop"}
              </button>
            </div>
          </div>
          {!crawlNow && avail ? (
            <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-amber-400/90">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Connect Instagram on your desktop so these links can crawl. They'll still save here.
            </p>
          ) : null}
          {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
        </div>

        {accounts.some((a) => a.status === "processing") && (
          <ul className="flex flex-col gap-1.5">
            {accounts
              .filter((a) => a.status === "processing")
              .map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-sm"
                >
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-400" />
                  <span className="min-w-0 truncate text-zinc-200">@{a.username}</span>
                  <span className="ml-auto text-[11px] text-zinc-500">Pulling catalog</span>
                </li>
              ))}
          </ul>
        )}

        {accounts
          .filter((a) => a.mine)
          .map((a) => (
            <AccountStatsCard key={a.id} id={a.id} />
          ))}

        <MobileAnalyzerLibrary posts={posts} onChanged={refresh} />
      </div>
    </div>
  );
}
