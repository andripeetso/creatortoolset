import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useNavigate, useParams } from "react-router";
import {
  ArrowLeft,
  BarChart3,
  Check,
  Eye,
  Instagram,
  LayoutGrid,
  List,
  Loader2,
  RefreshCw,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { canUse, useMe } from "@/lib/auth";
import { timeAgo } from "@/lib/exports";
import {
  analyzerHome,
  clampCatalogCount,
  createStack,
  DEFAULT_CATALOG_COUNT,
  deleteAccount,
  fmtAgeSince,
  fmtCount,
  fmtDate,
  fmtDelta,
  getAccount,
  getInstagramAvailability,
  isProcessing,
  keysInRange,
  kindLabel,
  patchPostResearch,
  playsVsMedian,
  pullCatalog,
  patchAccount,
  runAccountJobs,
  saveAccountTags,
  accountCatalogReady,
  sortCatalogItems,
  thumbUrl,
  virality,
  type AccountJobType,
  type CatalogItem,
  type CatalogSort,
  type DupCluster,
  type IdeaStatus,
  type InstagramAccount,
  type InstagramAvailability,
  type InstagramPost,
  type Recipe,
  type RunWhen,
  type SavedFor,
  type Tag,
  starsFromRank,
  kindBadgeClass,
  kindTextClass,
} from "@/lib/instagram";
import { WhatWorksPane } from "@/components/instagram/WhatWorks";
import { AccountStats, AccountTotals, StatsSection } from "@/components/instagram/AccountStats";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AppBar } from "@/components/AppBar";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import { RecipePicker } from "@/components/instagram/RecipePicker";
import { DEFAULT_RECIPE } from "@/components/instagram/RecipePicker";
import { TagsEditor } from "@/components/instagram/TagsEditor";
import { IdeaStatusSelect, RankStars, SavedForToggle } from "@/components/instagram/IdeaMark";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { QueueMenu } from "@/components/instagram/QueueMenu";
import { confirmHeavy } from "@/lib/setup";

const COUNT_PRESETS = [12, 25, 50];
const CATALOG_SORTS: { id: CatalogSort; label: string }[] = [
  { id: "posted", label: "Posted" },
  { id: "plays", label: "Plays" },
  { id: "likes", label: "Likes" },
  { id: "comments", label: "Comments" },
];

/**
 * An account's page. Given `accountId` it is embedded (the Workshop opens a creator in a modal): no header, a post opens through `onOpenPost`, removing closes it.
 */
export default function InstagramAccountPage({ accountId: fixedId, onOpenPost, onClose }: { accountId?: string; onOpenPost?: (id: string) => void; onClose?: () => void } = {}) {
  const params = useParams();
  const accountId = fixedId ?? params.accountId;
  const embedded = !!fixedId;
  const navigate = useNavigate();
  const base = analyzerHome();
  const me = useMe();
  const allowed = canUse(me, "instagram");
  const [account, setAccount] = useState<InstagramAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avail, setAvail] = useState<InstagramAvailability | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [recipe, setRecipe] = useState<Recipe>(DEFAULT_RECIPE);
  const [busy, setBusy] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [count, setCount] = useState(DEFAULT_CATALOG_COUNT);
  const [sort, setSort] = useState<CatalogSort>("posted");
  const [brokenAvatar, setBrokenAvatar] = useState(false);
  const [paneState, setPane] = useState<
    "catalog" | "library" | "reposts" | "public" | "trial" | "works" | null
  >(null);
  const [libView, setLibView] = useState<"grid" | "list">("grid");
  const [statsOpen, setStatsOpen] = useState(false);
  const [lastAnchor, setLastAnchor] = useState<string | undefined>();

  const load = useCallback(() => {
    if (!accountId) return;
    getAccount(accountId)
      .then((a) => {
        setBrokenAvatar(false);
        setAccount(a);
      })
      .catch((e) => setPageError(e instanceof Error ? e.message : "Could not open account"));
  }, [accountId]);

  useEffect(() => {
    if (!allowed) return;
    load();
    getInstagramAvailability()
      .then(setAvail)
      .catch(() => {});
  }, [allowed, load]);

  const processing = account?.status === "processing";
  useEffect(() => {
    if (!processing || !accountId) return;
    const t = window.setInterval(load, 800);
    return () => window.clearInterval(t);
  }, [processing, accountId, load]);

  useEffect(() => {
    setPane(null);
    setSelected(new Set());
    setLastAnchor(undefined);
  }, [accountId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const autoSync = useRef(false);
  useEffect(() => {
    if (autoSync.current || !account?.id || !account.mine || account.status === "processing") return;
    if (!accountCatalogReady(avail, true) || account.lastCatalogAt) return;
    if (!me || (me.role !== "admin" && me.username !== account.owner)) return;
    autoSync.current = true;
    void runAccountJobs(account.id, ["profile", "catalog"])
      .then((next) => {
        setAccount((cur) =>
          cur ? { ...next, catalog: cur.catalog, posts: cur.posts, snapshots: cur.snapshots } : next,
        );
      })
      .catch(() => {
        autoSync.current = false;
      });
  }, [account, avail, me]);

  if (!accountId) return null;
  const owns = !!me && !!account && (me.role === "admin" || me.username === account.owner);
  const catalogReady = accountCatalogReady(avail, account?.mine);
  const allCatalog = sortCatalogItems(account?.catalog ?? [], sort);
  const publicCatalog = allCatalog.filter((r) => r.visibility === "public");
  const trialCatalog = allCatalog.filter((r) => r.visibility === "trial");
  const pane = paneState ?? (account?.mine ? "public" : "library");
  const catalog =
    pane === "public" ? publicCatalog : pane === "trial" ? trialCatalog : allCatalog;
  const posts = account?.posts ?? [];
  const catalogPostIds = catalog
    .map((r) => r.postId)
    .filter((id): id is string => Boolean(id));
  /** Open a post with the list it came from, so it gets prev/next. */
  const openPost = (id: string, ids: string[]) =>
    embedded && onOpenPost ? onOpenPost(id) : navigate(`${base}/${id}`, { state: { browse: ids } });
  const insights = account?.insights;
  const allPlays = catalog
    .map((r) => r.counts.plays)
    .filter((n): n is number => typeof n === "number");

  const toggle = (code: string) => {
    setLastAnchor(code);
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const onCatalogClick = (code: string, e: MouseEvent) => {
    e.preventDefault();
    if (e.shiftKey) {
      const slice = keysInRange(
        catalog.map((r) => r.shortcode),
        lastAnchor,
        code,
      );
      setSelected((cur) => {
        const next = new Set(cur);
        for (const item of slice) next.add(item);
        return next;
      });
      return;
    }
    toggle(code);
  };

  const runJobs = async (types: AccountJobType[], extra: { more?: boolean } = {}) => {
    if (!account || !owns) return;
    setBusy(extra.more ? "more" : types.join(","));
    setError(null);
    try {
      const next = await runAccountJobs(account.id, types, {
        ...(account.mine ? {} : { count: clampCatalogCount(count) }),
        more: extra.more,
      });
      setAccount((cur) =>
        cur ? { ...next, catalog: cur.catalog, posts: cur.posts, snapshots: cur.snapshots } : next,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const pull = async (run: RunWhen, codes?: string[]) => {
    const picked = codes ?? [...selected];
    if (!account || !picked.length) return;
    if (run === "now" && !(await confirmHeavy("analyzer", picked.length))) return;
    setBusy(codes?.length === 1 ? `pull:${codes[0]}` : "pull");
    setError(null);
    try {
      const { errors } = await pullCatalog(account.id, picked, { recipe, run });
      if (!codes) setSelected(new Set());
      load();
      if (errors.length) setError(`${errors.length} failed: ${errors[0].error}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const applyPost = (p: InstagramPost) => {
    setAccount((cur) =>
      cur ? { ...cur, posts: (cur.posts ?? []).map((x) => (x.id === p.id ? p : x)) } : cur,
    );
  };

  const markPost = async (
    id: string,
    patch: { ideaStatus?: IdeaStatus; rank?: number | null; savedFor?: SavedFor[] },
  ) => {
    applyPost(await patchPostResearch(id, patch));
  };

  const saveTags = async (tags: Tag[]) => {
    if (!account) return;
    try {
      const next = await saveAccountTags(account.id, tags);
      setAccount((cur) =>
        cur ? { ...next, catalog: cur.catalog, posts: cur.posts, snapshots: cur.snapshots } : next,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async () => {
    if (!account) return;
    await deleteAccount(account.id).catch(() => {});
    if (embedded) onClose?.();
    else navigate(base);
  };

  const stackCluster = async (cluster: DupCluster) => {
    const ids = cluster.members.map((m) => m.postId).filter((id): id is string => Boolean(id));
    if (ids.length < 2) return;
    setBusy("stack");
    setError(null);
    try {
      const title =
        cluster.members.find((m) => m.captionPreview)?.captionPreview?.slice(0, 60) ||
        (cluster.kind === "repost" ? "Repost" : "Variation");
      await createStack(title, ids);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`relative flex flex-col items-center text-zinc-200 ${embedded ? "pb-6" : "min-h-dvh bg-[#0b0b10] pb-[max(2.5rem,env(safe-area-inset-bottom))]"}`}>
      {!embedded && <AppBar tool="Content Analyzer" to={base} trail={account ? `@${account.username}` : undefined} account={!!me}>
        {me ? (
          <>
            <QueueMenu base={base} busyHint={processing} onChange={load} />
            <ProjectSwitcher />
          </>
        ) : null}
      </AppBar>}

      <div className={`mx-auto w-[960px] max-w-[96%] ${embedded ? "mt-2" : "mt-6"}`}>
        {!embedded && (
          <button
            type="button"
            onClick={() => navigate(base)}
            className="mb-3 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> All posts
          </button>
        )}

        {pageError && !account ? (
          <p className="text-sm text-red-400">{pageError}</p>
        ) : !account ? (
          <p className="flex items-center gap-2 py-12 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Opening account…
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-start gap-4">
              <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-zinc-800">
                {account.avatarUrl && !brokenAvatar ? (
                  <img
                    src={`${account.avatarUrl}?t=${account.updatedAt}`}
                    alt=""
                    className="h-full w-full object-cover"
                    onError={() => setBrokenAvatar(true)}
                  />
                ) : (
                  <Instagram className="h-6 w-6 text-zinc-500" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="text-xl font-semibold text-zinc-100">
                  @{account.username}
                  {account.mine ? (
                    <span className="ml-2 rounded-md bg-violet-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      Mine
                    </span>
                  ) : null}
                  {account.isVerified ? (
                    <span className="ml-2 text-[11px] font-normal text-violet-300">verified</span>
                  ) : null}
                </h1>
                {account.fullName && <p className="text-sm text-zinc-400">{account.fullName}</p>}
                <AccountTotals account={account} catalog={allCatalog} className="mt-2">
                  <button
                    type="button"
                    onClick={() => setStatsOpen(true)}
                    className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    <BarChart3 className="h-3.5 w-3.5" /> All stats
                  </button>
                </AccountTotals>
                {account.biography && (
                  <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-400">{account.biography}</p>
                )}
              </div>
              {owns && (
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => {
                      const next = !account.mine;
                      setBusy("mine");
                      setError(null);
                      patchAccount(account.id, { mine: next })
                        .then((a) =>
                          setAccount((cur) =>
                            cur ? { ...cur, mine: a.mine } : { ...a },
                          ),
                        )
                        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                        .finally(() => setBusy(null));
                    }}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      account.mine
                        ? "border-violet-500/50 bg-violet-600/20 text-violet-100"
                        : "border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    }`}
                  >
                    {busy === "mine" ? "Saving…" : account.mine ? "My account" : "This is my account"}
                  </button>
                  <ConfirmButton
                    label="Remove"
                    confirmLabel="Click again to remove (posts stay)"
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                    onConfirm={remove}
                    className="flex items-center gap-1 rounded-md border border-transparent px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                    armedClassName="!border-red-500/50 !bg-red-500/10 !text-red-200"
                  />
                </div>
              )}
            </div>

            {processing && (
              <p className="mt-4 flex items-center gap-2 text-sm text-violet-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                {account.step || "Working"} · {Math.round((account.progress || 0) * 100)}%
              </p>
            )}
            {account.status === "error" && (
              <p className="mt-4 flex items-center gap-2 text-sm text-red-300">
                <TriangleAlert className="h-4 w-4" /> {account.error || "Account job failed"}
              </p>
            )}

            {owns && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!!busy || !catalogReady}
                  onClick={() => void runJobs(["profile", "catalog"])}
                  title={
                    account.mine
                      ? "Refresh profile and every post from the official Instagram login"
                      : "Refresh the profile and list the latest videos — nothing is ingested until you pull it"
                  }
                  className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {busy === "profile,catalog" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  {account.mine ? "Sync" : "Pull profile & catalog"}
                </button>
                {!account.mine && (
                  <>
                    <input
                      type="number"
                      min={1}
                      max={200}
                      value={count}
                      onChange={(e) => setCount(clampCatalogCount(e.target.value, count))}
                      className="w-14 rounded-md border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-200 outline-none focus:border-violet-500"
                      title="How many videos to list"
                    />
                    {COUNT_PRESETS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setCount(n)}
                        className={`rounded-md px-1.5 py-1 text-[11px] ${
                          count === n ? "text-violet-200" : "text-zinc-500 hover:text-zinc-300"
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </>
                )}
                <button
                  type="button"
                  disabled={!!busy || !catalogReady}
                  onClick={() => void runJobs(["stats"])}
                  className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {busy === "stats" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  Refresh stats
                </button>
                {account.lastCatalogAt ? (
                  <span className="text-[11px] text-zinc-600">synced {timeAgo(account.lastCatalogAt)}</span>
                ) : null}
              </div>
            )}

            <Dialog open={statsOpen} onOpenChange={setStatsOpen}>
              <DialogContent
                aria-describedby={undefined}
                className="max-h-[90vh] grid-cols-1 overflow-y-auto border-zinc-800 bg-[#0b0b10] text-zinc-200 sm:max-w-4xl"
              >
                <div>
                  <DialogTitle className="text-lg">@{account.username}</DialogTitle>
                  <AccountTotals account={account} catalog={allCatalog} className="mt-2" />
                </div>
                <AccountStats account={account} catalog={allCatalog}>
                  <StatsSection
                    title="Tags"
                    action={
                      owns ? (
                        <button
                          type="button"
                          disabled={!!busy || !catalogReady}
                          onClick={() => void runJobs(["tags"])}
                          className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                        >
                          {busy === "tags" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                          Suggest tags
                        </button>
                      ) : undefined
                    }
                  >
                    <TagsEditor tags={account.tags} onChange={owns ? saveTags : undefined} />
                  </StatsSection>
                </AccountStats>
              </DialogContent>
            </Dialog>

            {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

            <div className="mt-8 flex flex-wrap gap-1 border-b border-zinc-800 pb-px">
              {(
                account.mine
                  ? ([
                      ["public", `Public · ${publicCatalog.length}`],
                      ["trial", `Trial · ${trialCatalog.length}`],
                      ["library", `Library · ${posts.length}`],
                      ...(insights?.whatWorks ? [["works", "What works"] as const] : []),
                      ...((insights?.duplicates.length ?? 0)
                        ? [["reposts", `Reposts · ${insights!.duplicates.length}`] as const]
                        : []),
                    ] as Array<["public" | "trial" | "library" | "works" | "reposts", string]>)
                  : ([
                      ["library", `Library · ${posts.length}`],
                      ["catalog", `Catalog · ${allCatalog.length}`],
                      ...(insights?.whatWorks ? [["works", "What works"] as const] : []),
                      ...((insights?.duplicates.length ?? 0)
                        ? [["reposts", `Reposts · ${insights!.duplicates.length}`] as const]
                        : []),
                    ] as Array<["catalog" | "library" | "works" | "reposts", string]>)
              ).map(([id, tabLabel]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setPane(id)}
                  className={`rounded-t-md px-3 py-1.5 text-[11px] ${
                    pane === id
                      ? "border border-b-transparent border-zinc-700 bg-[#0b0b10] text-zinc-100"
                      : "border border-transparent text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {tabLabel}
                </button>
              ))}
            </div>

            {pane === "works" && insights?.whatWorks && (
              <WhatWorksPane
                data={insights.whatWorks}
                urlOf={(code) => allCatalog.find((row) => row.shortcode === code)?.url}
              />
            )}

            {pane === "library" && (
              <div className="mt-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <p className="text-[11px] text-zinc-500">
                    {posts.length} ingested {posts.length === 1 ? "post" : "posts"}
                  </p>
                  <div className="flex rounded-md border border-zinc-800 p-0.5">
                    {(["grid", "list"] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={libView === v}
                        title={v === "grid" ? "Grid, like Instagram" : "List with details"}
                        onClick={() => setLibView(v)}
                        className={`rounded px-1.5 py-1 ${
                          libView === v ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                        }`}
                      >
                        {v === "grid" ? <LayoutGrid className="h-3.5 w-3.5" /> : <List className="h-3.5 w-3.5" />}
                      </button>
                    ))}
                  </div>
                </div>
                {posts.length === 0 ? (
                  <p className="py-8 text-center text-sm text-zinc-600">
                    {account.mine
                      ? "The live list is Public / Trial. Pull a video here when you want media or a transcript to remake it."
                      : "Nothing from this account is in the library yet — pick videos in the catalog and pull them."}
                  </p>
                ) : libView === "grid" ? (
                  <div className="grid grid-cols-3 gap-1 sm:gap-1.5">
                    {posts.map((p) => (
                      <LibraryTile key={p.id} post={p} onOpen={() => openPost(p.id, posts.map((x) => x.id))} />
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {posts.map((p) => (
                      <SavedPostRow
                        key={p.id}
                        post={p}
                        onOpen={() => openPost(p.id, posts.map((x) => x.id))}
                        onMark={(patch) => void markPost(p.id, patch)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {pane === "reposts" && (
              <div className="mt-4 flex flex-col gap-3">
                {(insights?.duplicates ?? []).map((cluster, i) => (
                  <RepostCluster
                    key={`${cluster.kind}-${cluster.members.map((m) => m.shortcode).join("-")}-${i}`}
                    cluster={cluster}
                    catalog={catalog}
                    canStack={owns}
                    busy={!!busy}
                    onStack={() => void stackCluster(cluster)}
                    onOpenPost={(id) => openPost(id, catalogPostIds)}
                    onPull={(code) => void pull("now", [code])}
                  />
                ))}
              </div>
            )}

            {(pane === "catalog" || pane === "public" || pane === "trial") && (
              <div className={`mt-4 ${selected.size ? "pb-36" : ""}`}>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as CatalogSort)}
                    className="rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-200"
                  >
                    {CATALOG_SORTS.map((s) => (
                      <option key={s.id} value={s.id}>
                        Sort: {s.label}
                      </option>
                    ))}
                  </select>
                  {selected.size > 0 && (
                    <span className="text-[11px] text-zinc-500">{selected.size} selected</span>
                  )}
                </div>
                {catalog.length === 0 ? (
                  <p className="py-8 text-center text-sm text-zinc-600">
                    {pane === "trial"
                      ? "No trial reels: the official login marks none as not shared to the feed."
                      : pane === "public"
                        ? "No public posts listed yet — pull the profile & catalog."
                        : posts.length
                          ? "Pull profile & catalog to list more of this account's videos."
                          : "No videos listed yet — pull the profile & catalog."}
                  </p>
                ) : (
                  <div className="flex select-none flex-col gap-1">
                    {catalog.map((row) => (
                      <CatalogRow
                        key={row.shortcode}
                        row={row}
                        vsHint={playsVsMedian(row.counts.plays, insights?.medianPlays, allPlays)}
                        selected={selected.has(row.shortcode)}
                        pulling={busy === `pull:${row.shortcode}`}
                        canPull={owns && !!avail?.available && !processing}
                        onClick={(e) => onCatalogClick(row.shortcode, e)}
                        onPull={() => void pull("now", [row.shortcode])}
                        onOpenPost={
                          row.postId ? () => openPost(row.postId!, catalogPostIds) : undefined
                        }
                      />
                    ))}
                  </div>
                )}
                {owns && catalog.length > 0 && (
                  <div className="mt-3">
                    <button
                      type="button"
                      disabled={
                        !!busy ||
                        !catalogReady ||
                        account.catalogHasMore === false
                      }
                      onClick={() => void runJobs(["catalog"], { more: true })}
                      className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      {busy === "more" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      Load {account.mine ? "more" : clampCatalogCount(count) + " more"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {selected.size > 0 && (pane === "catalog" || pane === "public" || pane === "trial") && (
              <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-3">
                <div className="pointer-events-auto w-full max-w-xl rounded-2xl border border-zinc-700 bg-[#16161f] px-3 py-3">
                  <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                    <span>{selected.size} selected · click a row, shift-click a range</span>
                    <button
                      type="button"
                      onClick={() => setSelected(new Set())}
                      className="text-zinc-500 hover:text-zinc-200"
                    >
                      Clear
                    </button>
                  </div>
                  <RecipePicker compact recipe={recipe} onChange={setRecipe} />
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => void pull("later")}
                      className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      Save for later
                    </button>
                    <button
                      type="button"
                      disabled={!!busy || !avail?.available}
                      onClick={() => void pull("now")}
                      className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
                    >
                      {busy === "pull" ? "Running…" : `Run ${selected.size}`}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Instagram-style tile for the ingested-posts grid. */
function LibraryTile({ post, onOpen }: { post: InstagramPost; onOpen: () => void }) {
  const first = post.slides[0];
  const plays = virality(post);
  const pill = "rounded bg-black/65 px-1 py-0.5 text-[10px] font-medium text-zinc-100 backdrop-blur-sm";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative aspect-[4/5] overflow-hidden rounded-md bg-zinc-800 text-left"
      aria-label={post.caption.split("\n")[0] || "Open post"}
    >
      {first?.thumb ? (
        <img
          src={thumbUrl(post.id, 0)}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center">
          <Instagram className="h-5 w-5 text-zinc-600" />
        </span>
      )}
      <span className={`${pill} absolute left-1 top-1 ${kindBadgeClass(post.kind)}`}>
        {kindLabel(post.kind)}
        {post.kind === "carousel" && post.slides.length > 1 ? ` · ${post.slides.length}` : ""}
      </span>
      {post.ideaStatus === "done" ? (
        <span className={`${pill} absolute right-1 top-1 !bg-emerald-600/85`} title="Done">
          <Check className="h-3 w-3" />
        </span>
      ) : null}
      {plays ? (
        <span className={`${pill} absolute bottom-1 left-1 flex items-center gap-0.5`}>
          <Eye className="h-3 w-3" /> {fmtCount(plays)}
        </span>
      ) : null}
      {post.rank ? (
        <span className={`${pill} absolute bottom-1 right-1 flex items-center gap-0.5`}>
          <Star className="h-3 w-3 fill-amber-400 text-amber-400" /> {starsFromRank(post.rank)}
        </span>
      ) : null}
      {isProcessing(post) ? (
        <span className="absolute inset-x-0 bottom-0 h-1 bg-zinc-700">
          <span className="block h-full bg-violet-500" style={{ width: `${Math.round(post.progress * 100)}%` }} />
        </span>
      ) : null}
    </button>
  );
}

function SavedPostRow({
  post,
  onOpen,
  onMark,
}: {
  post: InstagramPost;
  onOpen: () => void;
  onMark: (patch: { ideaStatus?: IdeaStatus; rank?: number | null; savedFor?: SavedFor[] }) => void;
}) {
  const first = post.slides[0];
  return (
    <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5">
      <button
        type="button"
        onClick={onOpen}
        className="group -my-2.5 -ml-3 flex min-w-0 flex-1 items-center gap-3 self-stretch py-2.5 pl-3 text-left"
      >
        {first?.thumb ? (
          <img src={thumbUrl(post.id, 0)} alt="" className="h-14 w-11 shrink-0 rounded object-cover" />
        ) : (
          <div className="flex h-14 w-11 shrink-0 items-center justify-center rounded bg-zinc-800">
            <Instagram className="h-4 w-4 text-zinc-500" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-zinc-200">
            <span className={kindTextClass(post.kind)}>{kindLabel(post.kind)}</span>
            {virality(post) ? ` · ${fmtCount(virality(post))} plays` : ""}
          </p>
          <p className="truncate text-xs text-zinc-500">
            {post.status === "error" ? post.error : post.caption.split("\n")[0] || "Saved — jobs pending"}
          </p>
          <p className="text-[11px] text-zinc-600">
            {post.takenAt ? `${fmtDate(post.takenAt)} · ` : ""}
            added {timeAgo(post.createdAt)}
          </p>
        </div>
        {isProcessing(post) ? (
          <span className="flex items-center gap-1 text-[11px] text-violet-300">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {Math.round(post.progress * 100)}%
          </span>
        ) : null}
      </button>
      <div className="flex shrink-0 flex-col gap-1">
        <IdeaStatusSelect
          value={post.ideaStatus}
          onChange={(ideaStatus) => onMark({ ideaStatus })}
        />
        <SavedForToggle value={post.savedFor} onChange={(savedFor) => onMark({ savedFor })} />
        <RankStars value={post.rank} onChange={(rank) => onMark({ rank })} />
      </div>
    </div>
  );
}

function CatalogRow({
  row,
  selected,
  vsHint,
  pulling,
  canPull,
  onClick,
  onPull,
  onOpenPost,
}: {
  row: CatalogItem;
  selected: boolean;
  vsHint?: string;
  pulling: boolean;
  canPull: boolean;
  onClick: (e: MouseEvent) => void;
  onPull: () => void;
  onOpenPost?: () => void;
}) {
  const playDelta =
    row.prevCounts?.plays !== undefined && row.counts.plays !== undefined
      ? row.counts.plays - row.prevCounts.plays
      : undefined;
  return (
    <div
      onClick={onClick}
      className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-left ${
        selected ? "border-violet-500/50 bg-zinc-900" : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"
      }`}
    >
      <span className="relative shrink-0">
        {row.thumbnailUrl ? (
          <img src={row.thumbnailUrl} alt="" className="h-12 w-9 rounded object-cover" />
        ) : (
          <span className="block h-12 w-9 rounded bg-zinc-800" />
        )}
        {row.postId ? (
          <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-violet-600 text-white ring-2 ring-[#0b0b10]">
            <Check className="h-2.5 w-2.5" />
          </span>
        ) : null}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className={kindTextClass(row.kind)}>
            {kindLabel(row.kind)}
            {row.starred ? <Star className="ml-1 inline h-3 w-3 text-amber-400" /> : null}
          </span>
          {row.postId ? (
            <span className="rounded bg-violet-500/15 px-1 text-[10px] text-violet-200">In library</span>
          ) : null}
          {row.counts.plays !== undefined && (
            <span className="font-medium tabular-nums text-zinc-100">
              {fmtCount(row.counts.plays)} plays
              {playDelta ? (
                <span className="ml-1 text-[11px] font-normal text-zinc-500">{fmtDelta(playDelta)}</span>
              ) : null}
            </span>
          )}
          {row.insights?.reach !== undefined && (
            <span className="tabular-nums text-zinc-200">{fmtCount(row.insights.reach)} reach</span>
          )}
          {row.insights?.saved !== undefined && (
            <span className="tabular-nums text-zinc-400">{fmtCount(row.insights.saved)} saved</span>
          )}
          {row.insights?.shares !== undefined && (
            <span className="tabular-nums text-zinc-400">{fmtCount(row.insights.shares)} shares</span>
          )}
          {row.counts.likes !== undefined && (
            <span className="tabular-nums text-zinc-200">{fmtCount(row.counts.likes)} likes</span>
          )}
          {row.counts.comments !== undefined && (
            <span className="tabular-nums text-zinc-200">{fmtCount(row.counts.comments)} comments</span>
          )}
          {vsHint ? (
            <span
              className={`rounded px-1 text-[10px] ${
                vsHint === "low" ? "bg-zinc-800 text-zinc-500" : "bg-violet-500/15 text-violet-200"
              }`}
            >
              {vsHint} vs median
            </span>
          ) : null}
        </p>
        <p className="truncate text-xs text-zinc-500">{row.captionPreview || "No caption"}</p>
        <p className="text-[11px] text-zinc-600">
          {row.takenAt ? `${fmtDate(row.takenAt)} · ${fmtAgeSince(row.takenAt)} old` : "Date unknown"}
        </p>
      </div>
      {row.postId ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenPost?.();
          }}
          className="shrink-0 rounded-md px-2 py-1 text-[11px] text-violet-300 hover:bg-zinc-800"
        >
          Open
        </button>
      ) : (
        <button
          type="button"
          disabled={!canPull || pulling}
          onClick={(e) => {
            e.stopPropagation();
            onPull();
          }}
          className="shrink-0 rounded-md bg-violet-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {pulling ? "Pulling…" : "Pull"}
        </button>
      )}
    </div>
  );
}

function RepostCluster({
  cluster,
  catalog,
  canStack,
  busy,
  onStack,
  onOpenPost,
  onPull,
}: {
  cluster: DupCluster;
  catalog: CatalogItem[];
  canStack: boolean;
  busy: boolean;
  onStack: () => void;
  onOpenPost: (id: string) => void;
  onPull: (code: string) => void;
}) {
  const byCode = new Map(catalog.map((r) => [r.shortcode, r]));
  const stackable = cluster.members.filter((m) => m.postId).length >= 2;
  const caption = cluster.members.find((m) => m.captionPreview)?.captionPreview;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-violet-200">
          {cluster.kind === "repost" ? "Repost" : "Variation"} · {Math.round(cluster.score * 100)}%
        </span>
        {stackable && canStack && (
          <button
            type="button"
            disabled={busy}
            onClick={onStack}
            className="text-[11px] text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
          >
            Stack these
          </button>
        )}
      </div>
      {caption ? <p className="mb-2 truncate text-xs text-zinc-500">{caption}</p> : null}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {cluster.members.map((m) => {
          const row = byCode.get(m.shortcode);
          return (
            <button
              key={m.shortcode}
              type="button"
              onClick={() => (m.postId ? onOpenPost(m.postId) : onPull(m.shortcode))}
              className="w-16 shrink-0 text-left"
              title={m.captionPreview || m.shortcode}
            >
              {row?.thumbnailUrl ? (
                <img src={row.thumbnailUrl} alt="" className="h-[5.5rem] w-16 rounded object-cover" />
              ) : (
                <div className="flex h-[5.5rem] w-16 items-center justify-center rounded bg-zinc-800">
                  <Instagram className="h-4 w-4 text-zinc-500" />
                </div>
              )}
              <span className="mt-1 block truncate text-[10px] text-zinc-500">
                {m.postId ? "Saved" : "Pull"}
              </span>
            </button>
          );
        })}
        {cluster.libraryHits.map((h) => (
          <button
            key={h.postId}
            type="button"
            onClick={() => onOpenPost(h.postId)}
            className="w-16 shrink-0 text-left"
            title={`@${h.username}`}
          >
            <img src={thumbUrl(h.postId, 0)} alt="" className="h-[5.5rem] w-16 rounded object-cover" />
            <span className="mt-1 block truncate text-[10px] text-zinc-500">@{h.username}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
