import { Fragment, useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { ArrowRight, ChevronRight, Loader2, Lock, ScreenShare, type LucideIcon } from "lucide-react";
import { canUse, useMe, type Me } from "@/lib/auth";
import { isPhoneHub } from "@/lib/mobile";
import { shownTools, useOpenTool, withPluginTiles, type Tool as HomeTool } from "@/lib/tools";
import { AppBar } from "@/components/AppBar";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import { HomeTodo } from "@/components/HomeTodo";
import { TOOL_ICONS } from "@/components/setup/ToolNeeds";
import { webPlugins } from "@/plugins.gen";
import { useSessionSummaries } from "@/lib/workshop-summary";
import { listEdits } from "@/lib/editor";
import { listReviewAssets } from "@/lib/review";
import { currentProject, PROJECT_COLORS, projectColor, useWorkspace } from "@/lib/workspace";
import { useAppearance } from "@/lib/settings";
import { useShareTheme } from "@/components/ShareTheme";
import { readiness, TOOL_GROUPS, TOOL_NAMES, type Tool } from "@contracts/tools";
import { openSetupAt, resumeStep, setupFinished, setupOpen, useSetup } from "@/lib/setup";

/**
 * Creator Toolset: the landing hub. Two boxes side by side, Plan (analyze, write) and Make (edit, review), in the order
 * the work happens; under them the Extras, quieter. The order and the groups come from TOOL_GROUPS (contracts/tools.ts),
 * so this page and the rest of the app cannot drift. Each tile shows whether the tool is ready or needs setup, and a
 * red badge says how many things wait on you there. Each tool keeps its own route; this page just picks one.
 * Phones (and the installed PWA) use /m: the same stages, stacked, as icon grids. Caption Studio opens the simplified
 * /m/captions flow there. The top bar is the tool pages' own (AppBar), so nothing moves between Home and a tool.
 */

/** A tile on this page: a contracts tool, or the Mac app's Screen Recorder (no tool of its own, so no setup row). */
type Key = Tool | "record";

/** What a tile links to and says on hover. The tool's name and order come from TOOL_GROUPS and TOOL_NAMES. */
const PAGE: Record<Key, { to: string; phoneTo?: string; desc: string }> = {
  instagram: { to: "/instagram", desc: "Dump interesting posts. Rank, stack topics, remake your own." },
  workshop: { to: "/workshop", desc: "Search your research, take notes, draft reels, carousels, YouTube scripts, newsletters, X threads and articles." },
  editor: { to: "/editor", desc: "Raw takes in, draft timelines out: best takes, restarts and pauses cut, a preview in Review." },
  review: { to: "/review", desc: "Share a cut with one link. Reviewers comment and draw on the exact frame." },
  media: { to: "/library", desc: "Your footage in one place: upload, search by title and tag, preview." },
  enhance: { to: "/enhance", desc: "Studio sound for any recording: denoise, de-echo, level." },
  captions: { to: "/captions?view=projects", phoneTo: "/m/captions", desc: "Transcribe, caption and export: burned-in videos or alpha overlays." },
  clean: { to: "/clean", desc: "Clean metadata and compare fingerprints before posting." },
  stories: { to: "/stories", desc: "One video in, stories of about 20 s out: cut on the edit's cuts, pauses and beats. ZIP download." },
  notes: { to: "/clips", desc: "Drop in a recording: transcript, summary, chapters, takeaways." },
  guides: { to: "/documents", desc: "Turn recordings into SOPs, walkthroughs and guides you can publish." },
  // the Mac app's recorder (apps/mac Recorder.swift); Review and Video Notes start it too
  record: { to: "/record", desc: "Record your screen, a window or an area, with your camera and voice. Zooms where you click." },
};
const NAME: Record<Key, string> = { ...TOOL_NAMES, record: "Screen Recorder" };
const ICON: Record<Key, LucideIcon> = { ...TOOL_ICONS, record: ScreenShare };

/** The plug-in tiles (lib/tools.ts): each joins the box its stage names; a stage with no box here (Distribute) goes to Extras. */
const plugged = withPluginTiles(webPlugins);
const pluginTilesFor = (stage: string, me: Me | null): HomeTool[] =>
  shownTools(
    stage === "Extras"
      ? [...plugged.workflow.filter((s) => s.stage !== "Plan" && s.stage !== "Make").flatMap((s) => s.tools), ...plugged.other]
      : plugged.workflow.find((s) => s.stage === stage)?.tools ?? [],
    me,
  ).filter((t) => t.pluginTile);

/** Screen Recorder is open to whoever can use Review or Video Notes, the two places a recording goes. */
const canUseKey = (me: Me | null, k: Key) => (k === "record" ? canUse(me, "review") || canUse(me, "notes") : canUse(me, k));

export default function ToolsetHome() {
  const location = useLocation();
  const asked = new URLSearchParams(location.search).get("setup");
  const openTool = useOpenTool();
  const me = useMe();
  const phone = isPhoneHub();
  const showCounts = canUse(me, "workshop");
  const waiting = useWaiting(me);
  const project = useWorkspace(currentProject);
  const { projectTint, homeGlow } = useAppearance();
  // what's working right now: a Workshop reply being written. Its stage's box pulses and the tile says how many.
  const rows = useSessionSummaries();
  const running: Record<string, number> = showCounts ? { "/workshop": rows?.filter((r) => r.working).length ?? 0 } : {};
  // which tools are ready: read on mount and when the window comes back to the front (no polling)
  const view = useSetup((s) => s.view);
  const load = useSetup((s) => s.load);
  useEffect(() => {
    if (!me) return;
    void load();
    const again = () => void load();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [me, load]);

  const { dark } = useShareTheme();
  if (phone && location.pathname === "/") {
    return <Navigate to={{ pathname: "/m", search: location.search }} replace />;
  }
  if (!phone && location.pathname === "/m") {
    return <Navigate to={{ pathname: "/", search: location.search }} replace />;
  }

  /** Ready or needs setup for a tile, from the account's setup; null when there is nothing to say (no setup, or off). */
  const statusOf = (k: Key): boolean | null => {
    if (!view || !canUseKey(me, k)) return null;
    if (k === "record") return readiness("review", view.have).ready; // the recorder needs nothing Review doesn't
    if (view.tools && !view.tools.includes(k)) return null;
    return readiness(k, view.have).ready;
  };
  const extrasGroup = TOOL_GROUPS.find((g) => g.id === "tools");
  const extras: Key[] = [...(extrasGroup?.tools ?? []), "record"];

  // the current project's colour (Settings → Appearance can keep it violet), as CSS variables for the tiles and glow
  const c = PROJECT_COLORS[projectTint && project ? projectColor(project) : "violet"];
  const tintStyle = { "--tint": `rgb(${c.rgb})`, "--tint-text": `rgb(${dark ? c.text : c.rgb})`, transition: "--tint 500ms, --tint-text 500ms" } as React.CSSProperties;

  // one tile: its icon (in the project's colour), its name and its status; quiet = Extras, smaller and grey
  const tile = (k: Key, quiet = false) => {
    const Icon = ICON[k];
    const p = PAGE[k];
    const dest = phone && p.phoneTo ? p.phoneTo : p.to;
    const ok = canUseKey(me, k);
    const ready = statusOf(k);
    const body = (
      <>
        <span className={quiet
          ? "relative flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-800/80 transition-colors duration-200 group-hover:bg-zinc-700"
          : "relative flex h-12 w-12 items-center justify-center rounded-2xl 2xl:h-14 2xl:w-14 bg-[color-mix(in_srgb,var(--tint)_90%,transparent)] transition-colors duration-200 group-hover:bg-[var(--tint)]"}>
          <Icon className={quiet ? "h-5 w-5 text-[var(--tint-text)]" : "h-6 w-6 text-white"} />
          {!ok && <Lock className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full bg-zinc-900 p-0.5 text-zinc-300" />}
          {ok && (k === "workshop" ? showCounts && <WorkshopBadge /> : k !== "record" && <Badge n={waiting[k] ?? 0} means={BADGE_MEANS[k]} />)}
          {ok && running[dest] ? <Running n={running[dest]} verb="writing" /> : null}
          {ok && ready === false && <NeedsSetup />}
        </span>
        <span className={`text-xs leading-tight transition-colors duration-200 group-hover:text-zinc-50 ${quiet ? "text-zinc-400" : "text-zinc-300"}`}>{NAME[k]}</span>
      </>
    );
    // a light hover: the icon and the name brighten a little, faded, never moving (owner, 2026-11-08)
    const className = "group flex w-[88px] flex-col items-center gap-2 rounded-xl px-1 py-2 text-center 2xl:w-[104px]";
    if (!ok) {
      return (
        <div key={k} aria-disabled="true" title="Switched off for this account" className={`${className} cursor-not-allowed opacity-40`}>
          {body}
        </div>
      );
    }
    return dest.startsWith("https://") ? (
      <a key={k} href={dest} title={ready === false ? `${p.desc} · Needs setup` : p.desc} className={className}>
        {body}
      </a>
    ) : (
      <Link key={k} to={dest} title={ready === false ? `${p.desc} · Needs setup` : p.desc} onClick={(e) => openTool(e, dest)} className={className}>
        {body}
      </Link>
    );
  };

  // a plug-in's tile (lib/tools.ts withPluginTiles): its own icon, name and link; no status or badge
  const pluginTile = (t: HomeTool, quiet = false) => {
    const dest = phone && t.phoneTo ? t.phoneTo : t.to;
    const Icon = t.icon;
    const className = "group flex w-[88px] flex-col items-center gap-2 rounded-xl px-1 py-2 text-center 2xl:w-[104px]";
    const body = (
      <>
        <span className={quiet
          ? "relative flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-800/80 transition-colors duration-200 group-hover:bg-zinc-700"
          : "relative flex h-12 w-12 items-center justify-center rounded-2xl 2xl:h-14 2xl:w-14 bg-[color-mix(in_srgb,var(--tint)_90%,transparent)] transition-colors duration-200 group-hover:bg-[var(--tint)]"}>
          <Icon className={quiet ? "h-5 w-5 text-[var(--tint-text)]" : "h-6 w-6 text-white"} />
        </span>
        <span className={`text-xs leading-tight transition-colors duration-200 group-hover:text-zinc-50 ${quiet ? "text-zinc-400" : "text-zinc-300"}`}>{t.name}</span>
      </>
    );
    return dest.startsWith("https://") ? (
      <a key={t.to} href={dest} title={t.desc} className={className}>{body}</a>
    ) : (
      <Link key={t.to} to={dest} title={t.desc} onClick={(e) => openTool(e, dest)} className={className}>{body}</Link>
    );
  };

  return (
    <div
      style={tintStyle}
      className={`home-hub relative isolate select-none flex min-h-dvh flex-col items-center bg-zinc-950 pt-safe pb-safe text-zinc-200 ${
        phone ? "justify-start py-8" : "justify-center"
      }`}
    >
      {homeGlow && dark && ( // light: no glow (it banded and distracted there)
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <div
            className="home-glow absolute inset-0"
            style={{ background: "radial-gradient(ellipse 70% 50% at 50% 55%, color-mix(in srgb, var(--tint) 10%, transparent), transparent 70%)" }}
          />
        </div>
      )}
      {/* the tool pages' own bar (components/AppBar.tsx) with no tool and an invisible edge, so the name, the arrows and
          the account sit exactly where they do on every tool page and never move between them */}
      <AppBar className="absolute inset-x-0 top-0 mt-[env(safe-area-inset-top)] border-transparent">
        {canUse(me, "instagram") || canUse(me, "workshop") ? <ProjectSwitcher /> : null}
        <HomeTodo />
      </AppBar>
      {phone && <div className="h-16 shrink-0" />}

      <div className="flex w-[520px] max-w-[94vw] flex-col gap-3 min-[900px]:w-[900px] min-[900px]:gap-6 2xl:w-[1000px]">
        {view && !setupFinished(view) && !setupOpen(view, asked) && (
          <button
            type="button"
            onClick={() => openSetupAt(resumeStep())}
            className="flex items-center justify-between gap-3 rounded-xl border border-violet-500/30 bg-violet-500/5 px-4 py-3 text-left"
          >
            <span>
              <span className="block text-sm text-zinc-100">Finish setting up</span>
              <span className="block text-xs text-zinc-400">A few quick steps. Your answers are saved.</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
          </button>
        )}

        {/* the boxed groups (Plan, Make) in a row with arrows between, then Extras: quieter, a centred label */}
        <div className="flex flex-col gap-1.5 min-[900px]:grid min-[900px]:grid-cols-[1fr_auto_1fr] min-[900px]:gap-2">
          {TOOL_GROUPS.filter((g) => g.id !== "tools").map((g, i) => (
            <Fragment key={g.id}>
              {i > 0 && (
                <div className="flex items-center justify-center gap-2 self-center min-[900px]:w-28 min-[900px]:flex-col min-[900px]:gap-1 min-[900px]:px-3">
                  {showCounts && <Between />}
                  <ArrowRight className="h-4 w-4 shrink-0 rotate-90 text-zinc-600 min-[900px]:rotate-0" />
                </div>
              )}
              <section
                className={`rounded-2xl border p-3 ${g.tools.some((t) => canUse(me, t) && running[PAGE[t].to]) ? "home-busy" : ""} ${
                  g.id === "make"
                    ? "border-[color-mix(in_srgb,var(--tint)_30%,transparent)] bg-[color-mix(in_srgb,var(--tint)_5%,transparent)]"
                    : "border-zinc-800/80 bg-zinc-900/30"
                }`}
              >
                <h2 className="px-1 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">{g.label}</h2>
                <div className="flex items-start justify-center gap-4 min-[900px]:justify-evenly min-[900px]:gap-0">
                  {[...g.tools.map((t) => tile(t)), ...pluginTilesFor(g.label, me).map((t) => pluginTile(t))].map((node, j) => (
                    <Fragment key={j}>
                      {j > 0 && <ChevronRight className="mt-6 h-4 w-4 shrink-0 text-zinc-700 2xl:mt-7" />}
                      {node}
                    </Fragment>
                  ))}
                </div>
              </section>
            </Fragment>
          ))}
        </div>


        {/* one row whatever the number: the tools spread across the width from 900 px, wrapping below */}
        <section>
          <h2 className="flex items-center gap-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-600">
            <span className="h-px flex-1 bg-zinc-800/80" />
            {extrasGroup?.label ?? "Extras"}
            <span className="h-px flex-1 bg-zinc-800/80" />
          </h2>
          <div className="flex flex-wrap justify-center gap-x-2 gap-y-1 min-[900px]:grid min-[900px]:auto-cols-fr min-[900px]:grid-flow-col min-[900px]:justify-items-center min-[900px]:gap-0">
            {[...extras.map((k) => tile(k, true)), ...pluginTilesFor("Extras", me).map((t) => pluginTile(t, true))]}
          </div>
        </section>
      </div>

    </div>
  );
}

/** A tool that needs setup: a small amber dot on its icon, nothing for one that is ready (owner, 2026-11-09). */
function NeedsSetup() {
  return (
    <span
      role="img"
      aria-label="Needs setup"
      title="Needs setup"
      className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-[#0b0b10]"
    />
  );
}

/**
 * What waits on you at a tool, by its route: only what needs you, never what the AI or someone else is working on.
 * Workshop: replies you haven't read. AI Editor: edits whose last step failed or needs a key. Review: videos marked
 * Needs review. Read once for the page, again every 30 s while it is in front.
 */
function useWaiting(me: Me | null): Record<string, number> {
  const editor = canUse(me, "editor");
  const review = canUse(me, "review");
  const [counts, setCounts] = useState<{ editor: number; review: number }>({ editor: 0, review: 0 });
  useEffect(() => {
    if (!editor && !review) return;
    let live = true;
    const load = () =>
      void Promise.all([
        editor ? listEdits().then((l) => l.filter((e) => e.last?.state === "failed" || e.last?.state === "needs_key").length, () => 0) : 0,
        review ? listReviewAssets().then((l) => l.filter((a) => a.approval.status === "needs_review").length, () => 0) : 0,
      ]).then(([e, r]) => live && setCounts({ editor: e, review: r }));
    load();
    const t = window.setInterval(() => document.visibilityState === "visible" && load(), 30_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [editor, review]);
  return {
    editor: counts.editor,
    review: counts.review,
  };
}

/** Its own component, so only an account that can read the Workshop polls its sessions. */
function WorkshopBadge() {
  return <Badge n={(useSessionSummaries() ?? []).filter((r) => r.ready).length} means={BADGE_MEANS.workshop} />;
}

/** What a badge counts, said on hover. */
const BADGE_MEANS: Partial<Record<Tool, (n: number) => string>> = {
  workshop: (n) => `${plural(n, "session")} with replies you haven't read`,
  editor: (n) => `${plural(n, "edit")} whose last step failed or needs a key`,
  review: (n) => `${plural(n, "video")} to review`,
};

/** Work running at a tool, quiet beside its badge: a spinner and the count, never red. */
function Running({ n, verb }: { n: number; verb: string }) {
  return (
    <span
      title={`${n} ${verb}`}
      className="absolute -bottom-1.5 -right-1.5 flex items-center gap-1 whitespace-nowrap rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] leading-none text-zinc-300 ring-2 ring-[#0b0b10]"
    >
      <Loader2 className="h-2.5 w-2.5 animate-spin" /> {n} {verb}
    </span>
  );
}

function Badge({ n, means }: { n: number; means?: (n: number) => string }) {
  if (!n) return null;
  return (
    <span
      aria-label={means?.(n) ?? `${n} waiting`}
      title={means?.(n)}
      className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-semibold leading-none text-white ring-2 ring-zinc-950"
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Over the arrow into Make: what waits to enter it. Workshop sessions Ready (script done) or In Production (being
 * filmed), by the kind of their first piece ("4 reels / 3 carousels"). Nothing when there's none.
 */
function Between() {
  const rows = useSessionSummaries() ?? [];
  const waiting = rows.filter((r) => r.status === "ready" || r.status === "production");
  const reels = waiting.filter((r) => r.kinds[0] === "reel").length;
  const carousels = waiting.filter((r) => r.kinds[0] === "carousel").length;
  const other = waiting.length - reels - carousels;
  const parts = [reels && plural(reels, "reel"), carousels && plural(carousels, "carousel"), other && `${other} other`].filter(Boolean) as string[];
  if (!parts.length) return null;
  return (
    <Link
      to="/workshop"
      title="Workshop sessions Ready or In Production: scripts waiting to be filmed and made"
      className="flex flex-col items-center whitespace-nowrap text-center text-[11px] leading-tight text-[var(--tint-text)] transition-[filter] duration-200 hover:brightness-125 max-[899px]:flex-row max-[899px]:gap-1.5"
    >
      {parts.map((p) => <span key={p}>{p}</span>)}
    </Link>
  );
}
