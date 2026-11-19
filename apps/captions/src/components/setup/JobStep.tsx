import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Compass, type LucideIcon } from "lucide-react";
import type { WatchStatus } from "@contracts/library";
import { TOOL_NAMES, type Have, type Need, type Tool } from "@contracts/tools";
import type { Job } from "@contracts/work-prefs";
import { Button } from "@/components/ui/button";
import { listLibraries } from "@/lib/library";
import { JOB_SETUP, jobNeeds, jobsFor } from "@/lib/setup";
import { Choice } from "./Choice";
import { NeedLine, NeedRow, TOOL_ICONS } from "./ToolNeeds";

const JOB_ICONS: Record<Job, LucideIcon> = { ideas: TOOL_ICONS.instagram, write: TOOL_ICONS.workshop, edit: TOOL_ICONS.editor, captions: TOOL_ICONS.captions, look: Compass };
const key = (n: Need) => n.anyOf.join();

/** The footage folders of the account's own library (the Media Library's and the AI Editor's watch list), read once. */
function useFootage(on: boolean) {
  const [lib, setLib] = useState<string | null>(null);
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [read, setRead] = useState(false);
  const reload = useCallback(async () => {
    const id = (await listLibraries().catch(() => []))[0]?.id;
    const r = id ? await fetch(`/api/library/${id}/watch`).catch(() => null) : null;
    if (id) setLib(id);
    if (r?.ok) setStatus((await r.json()) as WatchStatus);
    setRead(true);
  }, []);
  useEffect(() => {
    if (on && !read) void reload();
  }, [on, read, reload]);
  return { lib, status, read };
}

/** "Where are your videos?": the Media Library's setup sheet sets the folders up (one entry point), so this row opens it. */
function FootageRow({ status }: { status: WatchStatus }) {
  const navigate = useNavigate();
  const met = status.folders.length > 0;
  return (
    <NeedLine
      met={met}
      name="Footage folder"
      line={met ? status.folders.map((f) => f.path).join(", ") : undefined}
      button={
        <Button size="sm" variant="outline" className="h-7" onClick={() => navigate("/library?setup=1")}>
          Set up
        </Button>
      }
    />
  );
}

/**
 * "What do you want to do first?": her main job (work-prefs `job`), then what that job's tools still need, one row each
 * with its one button. The rows are a tool's own checklist rows (jobNeeds: the list Home's dots and a tool's card read);
 * a row done here stays, ticked. `ai` is what the AI row opens: setup's own Connect your AI. Edit my videos also asks
 * where her videos are, on a server that can read her folders.
 */
export function JobStep({ mine, have, job, onPick, ai }: { mine: readonly Tool[]; have: readonly Have[]; job: Job | null; onPick: (j: Job) => void; ai: ReactNode }) {
  const footage = useFootage(job === "edit" && (mine.includes("media") || mine.includes("editor")));
  const missing = jobNeeds(job, mine, have);
  // the rows shown since this job was picked: one done here stays on screen, ticked
  const shown = useRef<{ job: Job | null; keys: Set<string>; folder: boolean | null }>({ job, keys: new Set(), folder: null });
  if (shown.current.job !== job) shown.current = { job, keys: new Set(), folder: null };
  for (const n of missing) shown.current.keys.add(key(n));
  const folderOpen = !!footage.status?.allowed && footage.status.folders.length === 0;
  if (job === "edit" && footage.status && shown.current.folder === null) shown.current.folder = folderOpen;
  const rows = jobNeeds(job, mine, []).filter((n) => shown.current.keys.has(key(n)));
  const showFolder = job === "edit" && !!shown.current.folder && !!footage.lib && !!footage.status;
  const waiting = job === "edit" && !footage.read;
  const ready = !missing.length && !(job === "edit" && folderOpen);

  return (
    <div className="space-y-5">
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
      {job && job !== "look" && !waiting && (
        <div className="space-y-1">
          {(rows.length > 0 || showFolder) && (
            <ul className="divide-y divide-border">
              {rows.map((n) => (
                <NeedRow key={key(n)} need={n} met={!missing.some((m) => key(m) === key(n))} welcome form={n.form === "ai" ? ai : undefined} />
              ))}
              {showFolder && <FootageRow status={footage.status!} />}
            </ul>
          )}
          {ready && <p className="py-2 text-sm text-emerald-600 dark:text-emerald-400">{JOB_SETUP[job].ready}</p>}
        </div>
      )}
    </div>
  );
}
