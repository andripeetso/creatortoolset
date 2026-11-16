import { useNavigate } from "react-router";
import {
  AudioLines,
  Captions,
  Clapperboard,
  FileText,
  Library,
  Star,
  MessageSquareText,
  NotebookPen,
  PenTool,
  ScanSearch,
  ScreenShare,
  Scissors,
  Video,
} from "lucide-react";
import { canUse, type Me } from "@/lib/auth";
import { useStudio } from "@/lib/store";
import type { WebPlugin } from "@/lib/plugin";
import { webPlugins } from "@/plugins.gen";

/** Every tool, in Home's order: the hub (pages/ToolsetHome.tsx) and the top bar's tool menu (components/AppBar.tsx). */
export type Tool = {
  to: string;
  phoneTo?: string;
  icon: typeof Captions;
  name: string;
  desc: string;
  can: (me: Me | null) => boolean;
  /** A plug-in's tile: hidden (not locked) for an account whose gate is off, see shownTools. */
  pluginTile?: true;
};

const BUILTIN_WORKFLOW: { stage: string; tools: Tool[] }[] = [
  {
    stage: "Plan",
    tools: [
      {
        to: "/instagram",
        icon: ScanSearch,
        name: "Content Analyzer",
        desc: "Collect posts you like, rank them, find what works.",
        can: (me) => canUse(me, "instagram"),
      },
      {
        to: "/workshop",
        icon: NotebookPen,
        name: "Content Workshop",
        desc: "Research, notes and drafts for reels, carousels and ads.",
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
        desc: "Raw takes in, draft timelines out.",
        can: (me) => canUse(me, "editor"),
      },
      {
        to: "/review",
        icon: MessageSquareText,
        name: "Review",
        desc: "Share a cut with one link; comments on the frame.",
        can: (me) => canUse(me, "review"),
      },
    ],
  },
  {
    stage: "Distribute",
    tools: [
      {
        to: "/stories",
        icon: Scissors,
        name: "Story Splitter",
        desc: "One video in, stories of about 20 s out.",
        can: (me) => canUse(me, "stories"),
      },
      {
        // a view over the Media Library's Finals collection (pieces), gated with the library it reads
        to: "/finals",
        icon: Star,
        name: "Finals",
        desc: "Your finished reels, carousels and other pieces, with the winner, versions and where each was posted.",
        can: (me) => canUse(me, "media"),
      },
    ],
  },
];

/** The tools you may use but don't have to: under the stages, quieter. */
const BUILTIN_OTHER: Tool[] = [
  {
    to: "/library",
    icon: Library,
    name: "Media Library",
    desc: "Your footage in one place, searchable.",
    can: (me) => canUse(me, "media"),
  },
  {
    to: "/enhance",
    icon: AudioLines,
    name: "Audio Enhancer",
    desc: "Studio sound for any recording.",
    can: (me) => canUse(me, "enhance"),
  },
  {
    to: "/captions?view=projects",
    phoneTo: "/m/captions",
    icon: Captions,
    name: "Caption Studio",
    desc: "Transcribe, caption and export.",
    can: (me) => canUse(me, "captions"),
  },
  {
    to: "/design",
    icon: PenTool,
    name: "Designer",
    desc: "Carousels, covers and thumbnails, designed in layers you can edit.",
    can: (me) => canUse(me, "design"),
  },
  {
    to: "/clips",
    icon: Video,
    name: "Video Notes",
    desc: "A recording in: transcript, summary, chapters.",
    can: (me) => canUse(me, "notes"),
  },
  {
    // the Mac app's recorder (apps/mac Recorder.swift); Review and Video Notes start it too
    to: "/record",
    icon: ScreenShare,
    name: "Screen Recorder",
    desc: "Record your screen, a window or an area, with your camera and voice.",
    can: (me) => canUse(me, "review") || canUse(me, "notes"),
  },
  {
    to: "/documents",
    icon: FileText,
    name: "Guide Builder",
    desc: "Turn recordings into guides and SOPs.",
    can: (me) => canUse(me, "guides"),
  },
];

/**
 * The Home stages and the quiet Tools row with each plug-in's tiles added at the end of the stage it names. A
 * plug-in tile is on unless its gate is off for the account (its `can`); Home hides it then (shownTools).
 */
export function withPluginTiles(plugins: WebPlugin[]): { workflow: { stage: string; tools: Tool[] }[]; other: Tool[] } {
  const workflow = BUILTIN_WORKFLOW.map((s) => ({ ...s, tools: [...s.tools] }));
  const other = [...BUILTIN_OTHER];
  for (const p of plugins) {
    for (const t of p.tiles ?? []) {
      const tool: Tool = {
        to: t.to,
        phoneTo: t.phoneTo,
        icon: t.icon,
        name: t.name,
        desc: t.desc,
        can: (me) => canUse(me, t.gate),
        pluginTile: true,
      };
      if (t.stage === "Tools") {
        other.push(tool);
        continue;
      }
      const stage = workflow.find((s) => s.stage === t.stage);
      if (!stage) throw new Error(`plug-in ${p.id}: tile "${t.name}" names no stage "${t.stage}"`);
      stage.tools.push(tool);
    }
  }
  return { workflow, other };
}

let layout: ReturnType<typeof withPluginTiles> | undefined;
/** The app's own layout with every loaded plug-in's tiles. Read when drawn: the Mac app's folder plug-ins join the list just before the first render. */
export const toolLayout = () => (layout ??= withPluginTiles(webPlugins));

/** The tools Home draws for an account: a plug-in tile whose gate is off is left out; built-in tools stay (locked). */
export const shownTools = (tools: Tool[], me: Me | null): Tool[] => tools.filter((t) => !t.pluginTile || t.can(me));

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
