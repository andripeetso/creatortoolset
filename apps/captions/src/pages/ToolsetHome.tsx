import { Fragment, useEffect, useState, type CSSProperties } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { ArrowRight, ChevronRight, Loader2, Lock, ScreenShare, Star, type LucideIcon } from "lucide-react";
import { canUse, canUseTile, useMe, type Me } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { isPhoneHub } from "@/lib/mobile";
import { shownTools, useOpenTool, withPluginTiles, type Tool as HomeTool } from "@/lib/tools";
import { AppBar } from "@/components/AppBar";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import { HomeTodo, useTodoLists } from "@/components/HomeTodo";
import { HomeIntro, IntroCaption, STAGE_SAYS, useIntroBeat } from "@/components/HomeIntro";
import { TOOL_ICONS } from "@/components/setup/ToolNeeds";
import { webPlugins } from "@/plugins.gen";
import { useSessionSummaries } from "@/lib/workshop-summary";
import { accentFor, accentTones, currentProject, projectColor, useWorkspace } from "@/lib/workspace";
import { useAppearance } from "@/lib/settings";
import { useShareTheme } from "@/components/ShareTheme";
import { onHome, readiness, TOOL_GROUPS, TOOL_NAMES, type HomeTile, type Tool } from "@contracts/tools";
import { DOWNLOAD_URL, introPlays, onSettingsClosed, openSetupAt, resumeStep, setupDismissed, setupFinished, shareDownload, startIntro, stillMotion, useSetup, useSetupShown } from "@/lib/setup";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Creator Toolset: the landing hub. Two boxes side by side, Plan (analyze, write) and Make (edit, review), in the order
 * the work happens; under them the Extras, quieter. The order and the groups come from TOOL_GROUPS (contracts/tools.ts),
 * so this page and the rest of the app cannot drift. Each tile shows whether the tool is ready or needs setup, and a
 * red badge says how many things wait on you there. Each tool keeps its own route; this page just picks one.
 * Phones (and the installed PWA) use /m: the same stages, stacked, as icon grids. Caption Studio opens the simplified
 * /m/captions flow there. The top bar is the tool pages' own (AppBar), so nothing moves between Home and a tool.
 */

/** A tile on this page: a contracts tool, or the Mac app's Screen Recorder (no tool of its own, so no setup row). */
type Key = Tool | "record" | "finals";

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
  finals: { to: "/finals", desc: "Your finished reels, carousels and other pieces, with the winner, versions and where each was posted." },
};
const NAME: Record<Key, string> = { ...TOOL_NAMES, record: "Screen Recorder", finals: "Finals" };
const ICON: Record<Key, LucideIcon> = { ...TOOL_ICONS, record: ScreenShare, finals: Star };

/** The plug-in tiles (lib/tools.ts): each joins the box its stage names; a stage with no box here (Distribute) goes to Extras. */
const plugged = withPluginTiles(webPlugins);
const pluginTilesFor = (stage: string, me: Me | null): HomeTool[] =>
  shownTools(
    stage === "Extras"
      ? [...plugged.workflow.filter((s) => !["Plan", "Make", "Distribute"].includes(s.stage)).flatMap((s) => s.tools), ...plugged.other]
      : plugged.workflow.find((s) => s.stage === stage)?.tools ?? [],
    me,
  ).filter((t) => t.pluginTile);

/** A stage box's edge and fill (Make, the middle one, in the project's colour). The welcome's frame draws the same (index.css .intro-frame). */
const boxLook = (id: string) =>
  id === "make"
    ? "border-[color-mix(in_srgb,var(--tint)_30%,transparent)] bg-[color-mix(in_srgb,var(--tint)_5%,transparent)]"
    : "border-zinc-800/80 bg-zinc-900/30";

/** Finals is a view of the Media Library; the rest is the tile's own rule (canUseTile: the Screen Recorder's is there). */
const canUseKey = (me: Me | null, k: Key) => (k === "finals" ? canUse(me, "media") : canUseTile(me, k));

export default function ToolsetHome() {
  const location = useLocation();
  const setupUp = useSetupShown((s) => s.shown);
  const [shared, setShared] = useState<Awaited<ReturnType<typeof shareDownload>> | null>(null);
  const openTool = useOpenTool();
  const me = useMe();
  const phone = isPhoneHub();
  const showCounts = canUse(me, "workshop");
  const waiting = useWaiting(me);
  const project = useWorkspace(currentProject);
  const { projectTint, homeGlow, ownColour } = useAppearance();
  // what's working right now: a Workshop reply being written. Its stage's box pulses and the tile says how many.
  const rows = useSessionSummaries();
  const running: Record<string, number> = showCounts ? { "/workshop": rows?.filter((r) => r.working).length ?? 0 } : {};
  // which tools are ready: the saved setup, live (lib/setup.ts useSetupSync). Read again on coming Home and when Settings
  // closes, since this window's own changes (a key added in a tool or in Settings) send it no notice
  const view = useSetup((s) => s.view);
  const load = useSetup((s) => s.load);
  // Home's tiles are all but the ones switched off under Settings → Tools (contracts onHome). Tiles wait for the
  // setup to load (or to fail: a guest has none, and then nothing is hidden), so a hidden tile is never drawn and dropped.
  // Every tile waits, Finals and a plug-in's too: drawn alone on a first visit, they jumped to their place when the rest came.
  const [loaded, setLoaded] = useState(false);
  const known = loaded || view !== null;
  const shownOnHome = (t: HomeTile) => known && onHome(view?.hidden, t);
  useEffect(() => {
    if (!me) return;
    void load().finally(() => setLoaded(true));
    return onSettingsClosed(() => void load());
  }, [me, load]);

  // the welcome after setup (components/HomeIntro.tsx): the beat it is on, as data-intro on the page. /?intro=1 plays it again
  const beat = useIntroBeat();
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("intro")) startIntro(introPlays({ finishedBefore: false, seen: false, phone, still: stillMotion() }));
  }, [phone]);
  // the welcome brings the boxes' tiles in one at a time, in the order they are drawn (index.css .intro-tile)
  let nth = 0;

  const { dark } = useShareTheme();
  if (phone && location.pathname === "/") {
    return <Navigate to={{ pathname: "/m", search: location.search }} replace />;
  }
  if (!phone && location.pathname === "/m") {
    return <Navigate to={{ pathname: "/", search: location.search }} replace />;
  }

  /** What a tile still needs, from the account's setup (none when nothing): one entry per missing thing. */
  const statusOf = (k: Key): string[] => {
    if (!view || !canUseKey(me, k)) return [];
    // the recorder needs nothing Review doesn't; Finals is a view of the Media Library
    const tool = k === "record" ? "review" : k === "finals" ? "media" : k;
    if (view.tools && !view.tools.includes(tool)) return [];
    return readiness(tool, view.have).missing.map((n) => n.what);
  };
  const extrasGroup = TOOL_GROUPS.find((g) => g.id === "tools");
  const extras: Key[] = [...(extrasGroup?.tools ?? []), "record" as const].filter(shownOnHome);

  // the current project's colour (Settings → Appearance can keep it violet), as CSS variables for the tiles and glow
  const c = accentTones(accentFor(projectTint, ownColour, project ? projectColor(project) : null));
  const tintStyle = { "--tint": `rgb(${c.rgb})`, "--tint-text": `rgb(${dark ? c.text : c.rgb})`, transition: "--tint 500ms, --tint-text 500ms" } as React.CSSProperties;

  // one tile: its icon (in the project's colour), its name and its status; quiet = Extras, smaller and grey
  const tile = (k: Key, quiet = false) => {
    const Icon = ICON[k];
    const p = PAGE[k];
    const dest = phone && p.phoneTo ? p.phoneTo : p.to;
    const ok = canUseKey(me, k);
    const missing = statusOf(k);
    const body = (
      <>
        <span className={quiet
          ? "relative flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-800/80 transition-colors duration-200 group-hover:bg-zinc-700"
          : "relative flex h-12 w-12 items-center justify-center rounded-2xl hub-2xl:h-14 hub-2xl:w-14 bg-[color-mix(in_srgb,var(--tint)_90%,transparent)] transition-colors duration-200 group-hover:bg-[var(--tint)]"}>
          <Icon className={quiet ? "h-5 w-5 text-[var(--tint-text)]" : "h-6 w-6 text-white"} />
          {!ok && <Lock className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full bg-zinc-900 p-0.5 text-zinc-300" />}
          {ok && (k === "workshop" ? showCounts && <WorkshopBadge /> : k !== "record" && k !== "finals" && <Badge n={waiting[k] ?? 0} means={BADGE_MEANS[k]} />)}
          {ok && running[dest] ? <Running n={running[dest]} verb="writing" /> : null}
          {ok && missing.length > 0 && <NeedsSetup what={missing} />}
        </span>
        <span className={`text-xs leading-tight transition-colors duration-200 group-hover:text-zinc-50 ${quiet ? "text-zinc-400" : "text-zinc-300"}`}>{NAME[k]}</span>
      </>
    );
    // a light hover: the icon and the name brighten a little, faded, never moving (owner, 2026-11-08)
    const className = "group flex w-[88px] flex-col items-center gap-2 rounded-xl px-1 py-2 text-center hub-2xl:w-[104px]";
    if (!ok) {
      return (
        <div key={k} aria-disabled="true" title="Switched off for this account" className={`${className} cursor-not-allowed opacity-40`}>
          {body}
        </div>
      );
    }
    return dest.startsWith("https://") ? (
      <a key={k} href={dest} title={p.desc} className={className}>
        {body}
      </a>
    ) : (
      <Link key={k} to={dest} title={p.desc} onClick={(e) => openTool(e, dest)} className={className}>
        {body}
      </Link>
    );
  };

  // a plug-in's tile (lib/tools.ts withPluginTiles): its own icon, name and link; no status or badge
  const pluginTile = (t: HomeTool, quiet = false) => {
    const dest = phone && t.phoneTo ? t.phoneTo : t.to;
    const Icon = t.icon;
    const className = "group flex w-[88px] flex-col items-center gap-2 rounded-xl px-1 py-2 text-center hub-2xl:w-[104px]";
    const body = (
      <>
        <span className={quiet
          ? "relative flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-800/80 transition-colors duration-200 group-hover:bg-zinc-700"
          : "relative flex h-12 w-12 items-center justify-center rounded-2xl hub-2xl:h-14 hub-2xl:w-14 bg-[color-mix(in_srgb,var(--tint)_90%,transparent)] transition-colors duration-200 group-hover:bg-[var(--tint)]"}>
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

  // the boxed groups with their tiles: a group whose tiles are all switched off (Settings → Tools) is not drawn, and
  // the row of boxes keeps its arrows between the ones that are left
  const boxes = (known ? TOOL_GROUPS : []).filter((g) => g.id !== "tools")
    .map((g) => ({
      g,
      nodes: [...(g.id === "distribute" ? ["finals" as Key] : g.tools.filter(shownOnHome)).map((t) => tile(t)), ...pluginTilesFor(g.label, me).map((t) => pluginTile(t))],
    }))
    .filter((b) => b.nodes.length > 0);
  const boxColumns = ["", "hub:grid-cols-1", "hub:grid-cols-[1fr_auto_1fr]", "hub:grid-cols-[1fr_auto_1fr_auto_1fr]"][boxes.length] ?? "";
  const extraTiles = known ? [...extras.map((k) => tile(k, true)), ...pluginTilesFor("Extras", me).map((t) => pluginTile(t, true))] : [];

  return (
    <div
      style={tintStyle}
      data-intro={beat ?? undefined}
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
      {beat && <HomeIntro beat={beat} />}
      <AppBar className="intro-bar absolute inset-x-0 top-0 mt-[env(safe-area-inset-top)] bg-transparent">
        {canUse(me, "instagram") || canUse(me, "workshop") ? <ProjectSwitcher /> : null}
        <HomeTodo />
      </AppBar>
      {phone && <div className="h-16 shrink-0" />}

      {/* the boxes go by the room the page has, not the window: a chat docked to the right takes 400px of it. As
          much room above and below as the bar takes, so a tall column stays clear of the bar and a short one centred */}
      <div className={`flex w-full justify-center [container:hub/inline-size] ${phone ? "" : "my-14"}`}>
      <div className="intro-body relative flex w-[520px] max-w-[94%] flex-col gap-3 hub:w-[1120px] hub:gap-6 hub-2xl:w-[1280px]">
        {beat && <IntroCaption beat={beat} />}
        {/* setup happens on the computer: a phone gets the way there, never the setup itself */}
        {view && !setupFinished(view) && phone && !view.have.includes("project") && (
          <div className="flex flex-col gap-3 rounded-xl border border-violet-500/30 bg-violet-500/5 px-4 py-3">
            <p className="text-sm text-zinc-100">Set up Creator Toolset on your computer first. Then add this phone from there.</p>
            <Button size="sm" variant="outline" className="self-start" onClick={() => void shareDownload().then(setShared)}>
              {shared === "copied" ? "Link copied" : shared === "shown" ? DOWNLOAD_URL.replace("https://", "") : "Share the download link"}
            </Button>
          </div>
        )}
        {/* the way back after Not now; an account that never saw setup (it has projects, or signed in before) gets no card */}
        {/* while the welcome plays (after Not now) it is out of the picture: it takes its place unseen on the last beat,
            behind the dimmed page, and fades in when the welcome ends */}
        {view && !setupFinished(view) && !phone && !setupUp && setupDismissed() && (!beat || beat === "all") && (
          <button
            type="button"
            onClick={() => openSetupAt(resumeStep())}
            className="intro-late flex items-center justify-between gap-3 rounded-xl border border-violet-500/30 bg-violet-500/5 px-4 py-3 text-left"
          >
            <span>
              <span className="block text-sm text-zinc-100">Finish setting up</span>
              <span className="block text-xs text-zinc-400">A few short questions. Your answers are saved.</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
          </button>
        )}

        {/* the boxed groups (Plan, Make, Distribute) in a row with arrows between, then Extras: quieter, a centred label */}
        <div className={`flex flex-col gap-1.5 hub:grid ${boxColumns} hub:gap-2`}>
          {boxes.map(({ g, nodes }, i) => (
            <Fragment key={g.id}>
              {i > 0 && (
                <div style={{ "--i": i } as CSSProperties} className="intro-link relative flex items-center justify-center gap-2 self-center hub:w-20 hub:flex-col hub:gap-1 hub:px-2">
                  {showCounts && i === 1 && <Between />}
                  <ArrowRight className="intro-arrow h-4 w-4 shrink-0 rotate-90 text-zinc-600 hub:rotate-0" />
                  {beat && <i className="intro-line" />}
                </div>
              )}
              <section
                style={{ "--i": i } as CSSProperties}
                className={`intro-box relative rounded-2xl border p-3 ${g.tools.some((t) => canUse(me, t) && running[PAGE[t].to]) ? "home-busy" : ""} ${boxLook(g.id)}`}
              >
                {/* the welcome only: the stage before it is a box (its number, name and what you do there), and the frame that opens into the box */}
                {beat && (
                  <>
                    <i className={`intro-frame ${boxLook(g.id)}`} />
                    <div className="intro-node">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--tint)] text-xs font-semibold text-white">{i + 1}</span>
                      <b className="text-zinc-50">{g.label}</b>
                      <span className="text-sm text-zinc-400">{STAGE_SAYS[g.id]}</span>
                    </div>
                  </>
                )}
                <h2 className="intro-label px-1 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">{g.label}</h2>
                <div className="flex items-start justify-center gap-4 hub:justify-evenly hub:gap-0">
                  {nodes.map((node, j) => (
                    <Fragment key={j}>
                      {j > 0 && <ChevronRight className="intro-chev mt-6 h-4 w-4 shrink-0 text-zinc-700 hub-2xl:mt-7" />}
                      <div className="intro-tile" style={{ "--i": nth++ } as CSSProperties}>{node}</div>
                    </Fragment>
                  ))}
                </div>
              </section>
            </Fragment>
          ))}
        </div>


        {/* one row whatever the number: the tools spread across the width from 900 px of room, wrapping below */}
        {extraTiles.length > 0 && (
        <section className="intro-extras">
          <h2 className="intro-extras-head flex items-center gap-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-600">
            <span className="h-px flex-1 bg-zinc-800/80" />
            {extrasGroup?.label ?? "Extras"}
            <span className="h-px flex-1 bg-zinc-800/80" />
          </h2>
          <div className="flex flex-wrap justify-center gap-x-2 gap-y-1 hub:grid hub:auto-cols-fr hub:grid-flow-col hub:justify-items-center hub:gap-0">
            {extraTiles.map((node, j) => (
              <div key={j} className="intro-extra flex" style={{ "--i": j } as CSSProperties}>{node}</div>
            ))}
          </div>
        </section>
        )}
      </div>
      </div>

    </div>
  );
}

/**
 * A tool that needs setup: a small amber dot on its icon, nothing for one that is ready (owner, 2026-11-09). Hovering the
 * dot says so and lists what is missing (owner, 2026-11-10); opening the tool brings up its checklist (FirstOpen). The
 * dot's empty `title` keeps the tile's own description from showing under the tooltip; the ring around it is only a
 * larger place to point at.
 */
function NeedsSetup({ what }: { what: string[] }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={`Not set up yet. Needs: ${what.join(", ")}`}
          title=""
          className="intro-late absolute -right-1 -top-1 h-3 w-3 rounded-full bg-amber-400 before:absolute before:-inset-2 before:content-['']"
        />
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-64 text-left">
        <p className="font-medium">Not set up yet</p>
        <ul className="mt-0.5">
          {what.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * What waits on you at a tool, by its route: only what needs you, never what the AI or someone else is working on.
 * Workshop: replies you haven't read. AI Editor: edits whose last step failed or needs a key. Review: videos marked
 * Needs review. From the to-do's saved lists, live (HomeTodo.tsx useTodoLists).
 */
function useWaiting(me: Me | null): Record<string, number> {
  const { edits, assets } = useTodoLists(me);
  return {
    editor: edits.filter((e) => e.last?.state === "failed" || e.last?.state === "needs_key").length,
    review: assets.filter((a) => a.approval.status === "needs_review").length,
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
      className="intro-late absolute -bottom-1.5 -right-1.5 flex items-center gap-1 whitespace-nowrap rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] leading-none text-zinc-300 ring-2 ring-[#0b0b10]"
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
      className="intro-late absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-semibold leading-none text-white ring-2 ring-zinc-950"
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
      className="intro-late flex flex-col items-center whitespace-nowrap text-center text-[11px] leading-tight text-[var(--tint-text)] transition-[filter] duration-200 hover:brightness-125 hub-narrow:flex-row hub-narrow:gap-1.5"
    >
      {parts.map((p) => <span key={p}>{p}</span>)}
    </Link>
  );
}
