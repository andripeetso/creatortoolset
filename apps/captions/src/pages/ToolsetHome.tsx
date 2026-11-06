import { Fragment } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import {
  ArrowRight,
  AudioLines,
  Captions,
  ChevronRight,
  Eraser,
  FileText,
  ScanSearch,
  Lock,
  Scissors,
  MessageSquareText,
  NotebookPen,
  Video,
} from "lucide-react";
import {
  canUse,
  isGuest,
  useViewedMe,
  type Me,
} from "@/lib/auth";
import { returnToOwnCaptionView, useAdminView } from "@/lib/admin-view";
import { isPhoneHub } from "@/lib/mobile";
import { useStudio } from "@/lib/store";
import { UserMenu } from "@/components/UserMenu";
import { ToolsetLogo } from "@/components/HomeLink";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";
import { useSessionSummaries } from "@/lib/workshop-summary";
import { currentProject, PROJECT_COLORS, projectColor, useWorkspace } from "@/lib/workspace";
import { useAppearance } from "@/lib/settings";

/**
 * Creator Toolset — the landing hub. The video workflow reads left to right
 * (idea → make → distribute), then Tools, the ones outside it. Each tool keeps its own route; this page just picks one. Phones
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
    stage: "Idea",
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

const OTHER: Tool[] = [
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
  const me = useViewedMe();
  const guest = isGuest(me);
  const adminCaptionView = useAdminView((s) => s.caption);
  const phone = isPhoneHub();
  const showCounts = !guest && !me?.demo && canUse(me, "workshop");
  const project = useWorkspace(currentProject);
  const { projectTint, homeGlow } = useAppearance();

  if (phone && location.pathname === "/") {
    return <Navigate to="/m" replace />;
  }
  if (!phone && location.pathname === "/m") {
    return <Navigate to="/" replace />;
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
    if (adminCaptionView) await returnToOwnCaptionView();
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
          title={guest ? "Disabled for guest users" : me?.demo ? undefined : "Access not enabled — ask an admin"}
          className={`${className} cursor-not-allowed opacity-40`}
        >
          {body}
        </div>
      );
    }
    const live = `group ${className} transition-colors hover:bg-zinc-800/60`;
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

  const tile = (t: Tool) =>
    toolLink(
      t,
      "flex w-full flex-col items-center gap-2 rounded-xl px-1 py-2 text-center lg:w-[88px] 2xl:w-[104px]",
      <>
        <span className="relative flex h-12 w-12 items-center justify-center rounded-2xl 2xl:h-14 2xl:w-14 bg-[color-mix(in_srgb,var(--tint)_90%,transparent)] group-hover:bg-[var(--tint)]">
          <t.icon className="h-6 w-6 text-white" />
          {!t.can(me) && (
            <Lock className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full bg-zinc-900 p-0.5 text-zinc-300" />
          )}
        </span>
        <span className="text-xs leading-tight text-zinc-300 group-hover:text-white">
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
        {!guest && (canUse(me, "instagram") || canUse(me, "workshop")) ? <ProjectSwitcher /> : null}
        <UserMenu />
      </div>

      <div className={`mb-10 flex items-center gap-3 ${phone ? "mt-16" : ""}`}>
        <ToolsetLogo className="h-12 w-12" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Creator Toolset
          </h1>
          {/* which project everything works in, right under the name */}
          {!guest && (canUse(me, "instagram") || canUse(me, "workshop")) ? (
            // no width of its own: a longer project name grows to the right, the logo and the name stay put
            <div className="w-0">
              <div className="w-max">
                <ProjectSwitcher variant="title" />
              </div>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">Everything your content needs before it ships</p>
          )}
          {guest && (
            <p className="mt-0.5 text-xs text-amber-400/80">
              Guest mode — Caption Studio, Review and the Audio Enhancer for files up to 3 minutes, other tools need an account
            </p>
          )}
        </div>
      </div>

      {/* the three stages, then Tools; Tools wraps under them when the window is too narrow for one line (< 1500 px) */}
      <div className="flex max-w-[94vw] flex-col gap-3 max-lg:w-[520px] lg:flex-row lg:flex-wrap lg:justify-center lg:gap-x-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:gap-2">
          {WORKFLOW.map((s, i) => (
            <Fragment key={s.stage}>
              {i > 0 && (
                <ArrowRight className="hidden h-4 w-4 shrink-0 self-center text-zinc-600 lg:block" />
              )}
              <section
                className={`rounded-2xl border p-3 ${
                  s.stage === "Make"
                    ? "border-[color-mix(in_srgb,var(--tint)_30%,transparent)] bg-[color-mix(in_srgb,var(--tint)_5%,transparent)]"
                    : "border-zinc-800/80 bg-zinc-900/30"
                }`}
              >
                <h2 className="flex items-baseline gap-2 px-1 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                  {s.stage}
                  {showCounts && <StageCount stage={s.stage} />}
                </h2>
                <div className="grid grid-cols-4 gap-1 lg:flex lg:items-start">
                  {s.tools.map((t, j) => (
                    <Fragment key={t.to}>
                      {j > 0 && (
                        <ChevronRight className="mt-6 hidden h-4 w-4 shrink-0 text-zinc-700 lg:block 2xl:mt-7" />
                      )}
                      {tile(t)}
                    </Fragment>
                  ))}
                </div>
              </section>
            </Fragment>
          ))}
        </div>
        {/* the fourth box, not a step of the flow: a gap before it, no arrow */}
        <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-3">
          <h2 className="px-1 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Tools
          </h2>
          <div className="grid grid-cols-4 gap-1 lg:flex lg:items-start">
            {OTHER.map(tile)}
          </div>
        </section>
      </div>

    </div>
  );
}

/** How many Workshop sessions sit in a stage, by their status; nothing when none. Distribute has no count: nothing
 *  records yet whether a finished piece went out. */
const STAGE_COUNT: Record<string, { statuses: string[]; label: string }> = {
  Idea: { statuses: ["draft", "writing"], label: "in writing" },
  Make: { statuses: ["ready", "production", "editing"], label: "in production" },
  Distribute: { statuses: ["toPost"], label: "ready to post" },
};
function StageCount({ stage }: { stage: string }) {
  const rows = useSessionSummaries();
  const c = STAGE_COUNT[stage];
  const n = c ? (rows ?? []).filter((r) => c.statuses.includes(r.status)).length : 0;
  if (!n) return null;
  return (
    <Link to="/workshop" className="normal-case tracking-normal text-[var(--tint-text)] hover:brightness-125">
      {n} {c.label}
    </Link>
  );
}
