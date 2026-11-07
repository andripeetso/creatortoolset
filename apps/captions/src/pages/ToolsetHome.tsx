import { Fragment, useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import {
  ArrowRight,
  AudioLines,
  Captions,
  ChevronRight,
  Eraser,
  FileText,
  ScanSearch,
  Library,
  Clapperboard,
  Lock,
  Scissors,
  MessageSquareText,
  NotebookPen,
  Video,
} from "lucide-react";
import { canUse, useMe, type Me } from "@/lib/auth";
import { isPhoneHub } from "@/lib/mobile";
import { useStudio } from "@/lib/store";
import { UserMenu } from "@/components/UserMenu";
import { ToolsetLogo } from "@/components/HomeLink";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import { useSessionSummaries } from "@/lib/workshop-summary";
import { listEdits } from "@/lib/editor";
import { listReviewAssets } from "@/lib/review";
import { currentProject, PROJECT_COLORS, projectColor, useWorkspace } from "@/lib/workspace";
import { useAppearance } from "@/lib/settings";

/**
 * Creator Toolset — the landing hub, in two rows of the same width. The work's three steps, left to right in the
 * order it happens: Plan (analyze, write) → Make (AI Editor, Review) → Distribute (clean, split for stories); under
 * them Tools, the ones you may use but don't have to. A red badge on a tool says how many things wait on you there.
 * Each tool keeps its own route; this page just picks one. Phones
 * (and the installed PWA) use /m: the same stages, stacked, as icon grids.
 * Caption Studio opens the simplified /m/captions flow there.
 */

type Tool = {
  to: string;
  phoneTo?: string;
  icon: typeof Captions;
  name: string;
  desc: string;
  can: (me: Me | null) => boolean;
};

const WORKFLOW: { stage: string; tools: Tool[] }[] = [
  {
    stage: "Plan",
    tools: [
      {
        to: "/instagram",
        icon: ScanSearch,
        name: "Content Analyzer",
        desc: "Dump interesting posts. Rank, stack topics, remake your own.",
        can: (me) => canUse(me, "instagram"),
      },
      {
        to: "/workshop",
        icon: NotebookPen,
        name: "Content Workshop",
        desc: "Search your research, take notes, draft reels, carousels and ads.",
        can: (me) => canUse(me, "workshop"),
      },
    ],
  },
  {
    stage: "Make",
    tools: [
      {
        to: "/editor",
        icon: Clapperboard,
        name: "AI Editor",
        desc: "Raw takes in, draft timelines out: best takes, restarts and pauses cut, a preview in Review.",
        can: (me) => canUse(me, "editor"),
      },
      {
        to: "/review",
        icon: MessageSquareText,
        name: "Review",
        desc: "Share a cut with one link. Reviewers comment and draw on the exact frame.",
        can: (me) => canUse(me, "review"),
      },
    ],
  },
  {
    stage: "Distribute",
    tools: [
      {
        to: "/clean",
        icon: Eraser,
        name: "Video Cleaner",
        desc: "Clean metadata and compare fingerprints before posting.",
        can: (me) => canUse(me, "clean"),
      },
      {
        to: "/stories",
        icon: Scissors,
        name: "Story Splitter",
        desc: "One video in, stories of about 20 s out: cut on the edit's cuts, pauses and beats. ZIP download.",
        can: (me) => canUse(me, "stories"),
      },
    ],
  },
];

/** The tools you may use but don't have to: under the stages, quieter. */
const OTHER: Tool[] = [
  {
    to: "/library",
    icon: Library,
    name: "Media Library",
    desc: "Your footage in one place: upload, search by title and tag, preview.",
    can: (me) => canUse(me, "media"),
  },
  {
    to: "/enhance",
    icon: AudioLines,
    name: "Audio Enhancer",
    desc: "Studio sound for any recording: denoise, de-echo, level.",
    can: (me) => canUse(me, "enhance"),
  },
  {
    to: "/captions?view=projects",
    phoneTo: "/m/captions",
    icon: Captions,
    name: "Caption Studio",
    desc: "Transcribe, caption and export: burned-in videos or alpha overlays.",
    can: (me) => canUse(me, "captions"),
  },
  {
    to: "/clips",
    icon: Video,
    name: "Video Notes",
    desc: "Drop in a recording: transcript, summary, chapters, takeaways.",
    can: (me) => canUse(me, "notes"),
  },
  {
    to: "/documents",
    icon: FileText,
    name: "Guide Builder",
    desc: "Turn recordings into SOPs, walkthroughs and guides you can publish.",
    can: (me) => canUse(me, "guides"),
  },
];

export default function ToolsetHome() {
  const location = useLocation();
  const navigate = useNavigate();
  const openProjectLibrary = useStudio((s) => s.openProjectLibrary);
  const me = useMe();
  const phone = isPhoneHub();
  const showCounts = canUse(me, "workshop");
  const waiting = useWaiting(me);
  const project = useWorkspace(currentProject);
  const { projectTint, homeGlow } = useAppearance();

  if (phone && location.pathname === "/") {
    return <Navigate to={{ pathname: "/m", search: location.search }} replace />;
  }
  if (!phone && location.pathname === "/m") {
    return <Navigate to={{ pathname: "/", search: location.search }} replace />;
  }

  const openTool = async (
    e: React.MouseEvent<HTMLAnchorElement>,
    to: string,
  ) => {
    // Preserve normal browser behavior for Cmd/Ctrl-click, middle-click, etc.
    // The URL itself carries the project-view intent, so new tabs work too.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    e.preventDefault();
    // Entering from the tool hub always opens Caption Studio's project view.
    // Keep the active project intact in memory so this navigation cannot lose
    // work; selecting a project or importing media opens the editor again.
    if (to.startsWith("/captions")) {
      openProjectLibrary();
    }
    navigate(to);
  };

  // One tool as a link, an external link, or a locked placeholder.
  const toolLink = (t: Tool, className: string, body: React.ReactNode) => {
    const dest = phone && t.phoneTo ? t.phoneTo : t.to;
    if (!t.can(me)) {
      return (
        <div
          key={t.to}
          aria-disabled="true"
          title="Switched off for this account"
          className={`${className} cursor-not-allowed opacity-40`}
        >
          {body}
        </div>
      );
    }
    const live = `group ${className}`; // hover lights the icon and the name only, no box behind them
    return dest.startsWith("https://") ? (
      <a key={t.to} href={dest} title={t.desc} className={live}>
        {body}
      </a>
    ) : (
      <Link
        key={t.to}
        to={dest}
        title={t.desc}
        onClick={(e) => void openTool(e, dest)}
        className={live}
      >
        {body}
      </Link>
    );
  };

  // the current project's colour (Settings → Appearance can keep it violet), as CSS variables for the tiles and glow
  const c = PROJECT_COLORS[projectTint && project ? projectColor(project) : "violet"];
  const tintStyle = { "--tint": `rgb(${c.rgb})`, "--tint-text": `rgb(${c.text})`, transition: "--tint 500ms, --tint-text 500ms" } as React.CSSProperties;

  // a stage's tools in the project's colour; Tools (quiet) smaller and grey, the colour only on the icon
  const tile = (t: Tool, quiet = false) =>
    toolLink(
      t,
      "flex w-[88px] flex-col items-center gap-2 rounded-xl px-1 py-2 text-center 2xl:w-[104px]",
      <>
        <span className={quiet
          ? "relative flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-800/80 group-hover:bg-zinc-700"
          : "relative flex h-12 w-12 items-center justify-center rounded-2xl 2xl:h-14 2xl:w-14 bg-[color-mix(in_srgb,var(--tint)_90%,transparent)] group-hover:bg-[var(--tint)]"}>
          <t.icon className={quiet ? "h-5 w-5 text-[var(--tint-text)]" : "h-6 w-6 text-white"} />
          {!t.can(me) && (
            <Lock className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full bg-zinc-900 p-0.5 text-zinc-300" />
          )}
          {t.can(me) && (t.to === "/workshop" ? showCounts && <WorkshopBadge /> : <Badge n={waiting[t.to] ?? 0} />)}
        </span>
        <span className={`text-xs leading-tight group-hover:text-white ${quiet ? "text-zinc-400" : "text-zinc-300"}`}>
          {t.name}
        </span>
      </>,
    );

  return (
    <div
      style={tintStyle}
      className={`relative isolate flex min-h-dvh flex-col items-center bg-[#0b0b10] pt-safe pb-safe text-zinc-200 ${
        phone ? "justify-start py-8" : "justify-center"
      }`}
    >
      {homeGlow && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{ background: "radial-gradient(ellipse 70% 50% at 50% 55%, color-mix(in srgb, var(--tint) 10%, transparent), transparent 70%)" }}
        />
      )}
      <div className="absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] flex items-center gap-2">
        {canUse(me, "instagram") || canUse(me, "workshop") ? <ProjectSwitcher /> : null}
        <UserMenu />
      </div>

      <div className={`mb-10 flex items-center gap-3 ${phone ? "mt-16" : ""}`}>
        <ToolsetLogo className="h-12 w-12" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Creator Toolset
          </h1>
          {/* which project everything works in, right under the name */}
          {canUse(me, "instagram") || canUse(me, "workshop") ? (
            // no width of its own: a longer project name grows to the right, the logo and the name stay put
            <div className="w-0">
              <div className="w-max">
                <ProjectSwitcher variant="title" />
              </div>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">Everything your content needs before it ships</p>
          )}
        </div>
      </div>

      {/* two rows: the work's three steps, verbs, in equal boxes; under them Tools, quieter, no box, a centred label
          as a divider and the tools spread evenly across the same width. Red badges say what waits where. */}
      <div className="flex w-[520px] max-w-[94vw] flex-col gap-3 lg:w-[900px] lg:gap-6 2xl:w-[1000px]">
        <div className="flex flex-col gap-1.5 lg:grid lg:grid-cols-[1fr_auto_1fr_auto_1fr] lg:gap-2">
          {WORKFLOW.map((s, i) => (
            <Fragment key={s.stage}>
              {i > 0 && (
                <div className="flex items-center justify-center gap-2 self-center lg:w-28 lg:flex-col lg:gap-1 lg:px-3">
                  {showCounts && <Between into={s.stage} />}
                  <ArrowRight className="h-4 w-4 shrink-0 rotate-90 text-zinc-600 lg:rotate-0" />
                </div>
              )}
              <section
                className={`rounded-2xl border p-3 ${
                  s.stage === "Make"
                    ? "border-[color-mix(in_srgb,var(--tint)_30%,transparent)] bg-[color-mix(in_srgb,var(--tint)_5%,transparent)]"
                    : "border-zinc-800/80 bg-zinc-900/30"
                }`}
              >
                <h2 className="px-1 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">{s.stage}</h2>
                <div className="flex items-start justify-center gap-4 lg:justify-evenly lg:gap-0">
                  {s.tools.map((t, j) => (
                    <Fragment key={t.to}>
                      {j > 0 && (
                        <ChevronRight className="mt-6 h-4 w-4 shrink-0 text-zinc-700 2xl:mt-7" />
                      )}
                      {tile(t)}
                    </Fragment>
                  ))}
                </div>
              </section>
            </Fragment>
          ))}
        </div>
        <section>
          <h2 className="flex items-center gap-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-600">
            <span className="h-px flex-1 bg-zinc-800/80" />
            Tools
            <span className="h-px flex-1 bg-zinc-800/80" />
          </h2>
          <div className="flex flex-wrap justify-center gap-x-2 gap-y-1 lg:grid lg:grid-cols-5 lg:justify-items-center lg:gap-0">
            {OTHER.map((t) => tile(t, true))}
          </div>
        </section>
      </div>

    </div>
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
    "/editor": counts.editor,
    "/review": counts.review,
  };
}

/** Its own component, so only an account that can read the Workshop polls its sessions. */
function WorkshopBadge() {
  return <Badge n={(useSessionSummaries() ?? []).filter((r) => r.ready).length} />;
}

function Badge({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span
      aria-label={`${n} waiting`}
      className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-semibold leading-none text-white ring-2 ring-[#0b0b10]"
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Over the arrow into a stage, what waits to enter it. Into Make: Workshop sessions Ready (script done) or In
 * Production (being filmed), by the kind of their first piece ("4 reels / 3 carousels"). Into Distribute: sessions
 * Ready to post. Nothing when there's none.
 */
function Between({ into }: { into: string }) {
  const rows = useSessionSummaries() ?? [];
  let parts: string[];
  let title: string;
  if (into === "Make") {
    const waiting = rows.filter((r) => r.status === "ready" || r.status === "production");
    const reels = waiting.filter((r) => r.kinds[0] === "reel").length;
    const carousels = waiting.filter((r) => r.kinds[0] === "carousel").length;
    const other = waiting.length - reels - carousels;
    parts = [reels && plural(reels, "reel"), carousels && plural(carousels, "carousel"), other && `${other} other`].filter(Boolean) as string[];
    title = "Workshop sessions Ready or In Production: scripts waiting to be filmed and made";
  } else {
    const n = rows.filter((r) => r.status === "toPost").length;
    parts = n ? [`${n} ready to post`] : [];
    title = "Workshop sessions Ready to post";
  }
  if (!parts.length) return null;
  return (
    <Link
      to="/workshop"
      title={title}
      className="flex flex-col items-center whitespace-nowrap text-center text-[11px] leading-tight text-[var(--tint-text)] hover:brightness-125 max-lg:flex-row max-lg:gap-1.5"
    >
      {parts.map((p) => <span key={p}>{p}</span>)}
    </Link>
  );
}
