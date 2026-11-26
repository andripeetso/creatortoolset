import { Compass, type LucideIcon } from "lucide-react";
import { TOOL_NAMES, type Tool } from "@contracts/tools";
import type { Job } from "@contracts/work-prefs";
import { JOB_SETUP, jobsFor } from "@/lib/setup";
import { Choice } from "./Choice";
import { TOOL_ICONS } from "./ToolNeeds";

const JOB_ICONS: Record<Job, LucideIcon> = { ideas: TOOL_ICONS.instagram, write: TOOL_ICONS.workshop, edit: TOOL_ICONS.editor, captions: TOOL_ICONS.captions, look: Compass };

/**
 * "What do you want to do first?": her main job (work-prefs `job`), one choice, each with the tools it is done with.
 * Nothing else is on this screen (owner, 2026-11-26): the rows of what the job's tools still need, each with a button
 * to another screen, turned one question into four setups. After setup the assistant's next steps name what is left
 * (lib/setup.ts setupLeft), and each tool asks for its own when it is opened.
 */
export function JobStep({ mine, job, onPick }: { mine: readonly Tool[]; job: Job | null; onPick: (j: Job) => void }) {
  return (
    <div role="radiogroup" aria-label="What do you want to do first?" className="grid gap-2 sm:grid-cols-2">
      {jobsFor(mine).map((j) => (
        <Choice
          key={j}
          on={job === j}
          onClick={() => onPick(j)}
          icon={JOB_ICONS[j]}
          name={JOB_SETUP[j].name}
          line={JOB_SETUP[j].tools.filter((t) => mine.includes(t)).map((t) => TOOL_NAMES[t]).join(" and ") || undefined}
        />
      ))}
    </div>
  );
}
