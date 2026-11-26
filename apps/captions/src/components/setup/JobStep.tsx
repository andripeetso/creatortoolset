import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Compass, type LucideIcon } from "lucide-react";
import type { LibrarySummary, WatchStatus } from "@contracts/library";
import { NEED_SENTENCE, needAction, rowState, TOOL_NAMES, type Have, type Need, type Tool } from "@contracts/tools";
import type { Job } from "@contracts/work-prefs";
import { Button } from "@/components/ui/button";
import { getWatch, listLibraries } from "@/lib/library";
import { JOB_SETUP, jobRows, jobsFor } from "@/lib/setup";
import { LibrarySetup } from "@/pages/library/Setup";
import { Choice } from "./Choice";
import { NeedLine, NeedRow, TOOL_ICONS } from "./ToolNeeds";

const JOB_ICONS: Record<Job, LucideIcon> = { ideas: TOOL_ICONS.instagram, write: TOOL_ICONS.workshop, edit: TOOL_ICONS.editor, captions: TOOL_ICONS.captions, look: Compass };
const key = (n: Need) => n.anyOf.join();
const isLibrary = (n: Need) => n.form === "library";

/** The account's own Media Library and the folders it reads (the Media Library's and the AI Editor's watch list). */
function useFootage(on: boolean) {
  const [lib, setLib] = useState<LibrarySummary | null>(null);
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [read, setRead] = useState(false);
  const reload = useCallback(async () => {
    const first = (await listLibraries().catch(() => []))[0] ?? null;
    setLib(first);
    setStatus(first ? await getWatch(first.id).catch(() => null) : null);
    setRead(true);
  }, []);
  useEffect(() => {
    if (on && !read) void reload();
  }, [on, read, reload]);
  return { lib, status, read, reload };
}

/**
 * "What do you want to do first?": her main job (work-prefs `job`), then that job's list, with no heading over it
 * (owner, 2026-11-26): every row of its tools as the thing to do ("Connect your AI", "Add a Deepgram key"), the
 * required ones first, an optional one saying so and what it adds. A row done already is ticked (a sign-in from the
 * screen before shows as done); one this computer covers by itself with nothing to add is left out. Nothing here has
 * to be done to go on: each row has its one button, to press or leave.
 * The rows are the tools' own checklist rows (jobRows: the list Home's dots and a tool's card read). Each opens where
 * she is: the AI row setup's own Connect your AI (`ai`), a key its field, and the Media Library its own setup over this
 * window, back here when it closes. The Media Library is one row, done once it has a folder to read.
 */
export function JobStep({ mine, have, job, onPick, ai, onChanged }: { mine: readonly Tool[]; have: readonly Have[]; job: Job | null; onPick: (j: Job) => void; ai: ReactNode; onChanged?: () => void }) {
  const navigate = useNavigate();
  const rows = jobRows(job, mine).filter((n) => rowState(n, have) !== "free");
  const library = rows.find(isLibrary);
  const footage = useFootage(!!library);
  const [librarySetup, setLibrarySetup] = useState(false);
  const folders = footage.status?.folders ?? [];
  const libraryDone = !!library && rowState(library, have) === "done" && !(footage.status?.allowed && folders.length === 0);
  // the Media Library's row waits for its folders, so it never shows open and then ticks itself
  const waiting = !!library && !footage.read;

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
      {!waiting && rows.length > 0 && (
        <ul className="divide-y divide-border">
          {rows.map((n) =>
            isLibrary(n) ? (
              <NeedLine
                key={key(n)}
                met={libraryDone}
                name={needAction(n).title}
                line={libraryDone ? folders.map((f) => f.path).join(", ") || undefined : NEED_SENTENCE.library}
                button={
                  // its own setup, over this window; with no library of her own to set up, the Media Library itself
                  <Button size="sm" variant="outline" className="h-7" onClick={() => (footage.lib ? setLibrarySetup(true) : navigate("/library?setup=1"))}>
                    {needAction(n).button}
                  </Button>
                }
              />
            ) : (
              <NeedRow key={key(n)} need={n} met={rowState(n, have) === "done"} welcome form={n.form === "ai" ? ai : undefined} />
            ),
          )}
        </ul>
      )}
      {librarySetup && footage.lib && (
        <LibrarySetup
          library={footage.lib}
          onDone={() => {
            setLibrarySetup(false);
            void footage.reload();
            onChanged?.();
          }}
          onClose={() => setLibrarySetup(false)}
        />
      )}
    </div>
  );
}
