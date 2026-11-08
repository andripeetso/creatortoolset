import { useNavigate } from "react-router";
import {
  AudioLines,
  Captions,
  Clapperboard,
  Eraser,
  FileText,
  Library,
  MessageSquareText,
  NotebookPen,
  ScanSearch,
  Scissors,
  Video,
} from "lucide-react";
import { canUse, type Me } from "@/lib/auth";
import { useStudio } from "@/lib/store";

/** Every tool, in Home's order: the hub (pages/ToolsetHome.tsx) and the top bar's tool menu (components/AppBar.tsx). */
export type Tool = {
  to: string;
  phoneTo?: string;
  icon: typeof Captions;
  name: string;
  desc: string;
  can: (me: Me | null) => boolean;
};

export const WORKFLOW: { stage: string; tools: Tool[] }[] = [
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
        desc: "Search your research, take notes, draft reels, carousels, YouTube scripts, newsletters, X threads and articles.",
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
export const OTHER: Tool[] = [
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

/** A click on a tool link: Caption Studio opens on its projects (the active project stays in memory, so nothing is
 *  lost). Cmd/Ctrl-click, middle-click etc. stay the browser's (the URL carries the view). */
export function useOpenTool() {
  const navigate = useNavigate();
  const openProjectLibrary = useStudio((s) => s.openProjectLibrary);
  return (e: React.MouseEvent<HTMLAnchorElement>, to: string) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    if (to.startsWith("/captions")) openProjectLibrary();
    navigate(to);
  };
}
