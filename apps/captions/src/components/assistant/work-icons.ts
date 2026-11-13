import { CalendarClock, Captions, Clapperboard, Film, Link2, NotebookText, PenLine, type LucideIcon } from "lucide-react";
import type { AssistantWork } from "@contracts/assistant";

/** The icon of each kind of thing a reply makes or opens: on its card, and on its chat's line in the list. */
export const WORK_ICONS: Record<AssistantWork["kind"], LucideIcon> = { workshop: PenLine, edit: Clapperboard, review: Film, automation: CalendarClock, link: Link2, notes: NotebookText, captions: Captions };
