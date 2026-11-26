import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Compass, type LucideIcon } from "lucide-react";
import type { LibrarySummary, WatchStatus } from "@contracts/library";
import { NEED_SENTENCE, TOOL_NAMES, type Have, type Need, type Tool } from "@contracts/tools";
import type { Job } from "@contracts/work-prefs";
import { Button } from "@/components/ui/button";
import { getWatch, listLibraries } from "@/lib/library";
import { JOB_SETUP, jobNeeds, jobsFor } from "@/lib/setup";
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
 * "What do you want to do first?": her main job (work-prefs `job`), then, under Still to set up, what that job's tools
 * still need: one row each with its one button. Nothing here has to be done to go on (owner, 2026-11-26: "they can
 * choose to trigger everything from here, they don't have to"); the assistant names what is left after setup too.
 * The rows are a tool's own checklist rows (jobNeeds: the list Home's dots and a tool's card read), and a row done here
 * stays, ticked. Each opens where she is: the AI row setup's own Connect your AI (`ai`), a key its field, and the Media
 * Library its own setup over this window, back here when it closes. The Media Library is one row: having none and
 * having no folder in it are the same thing to set up there, never a second row for the folder.
 */
export function JobStep({ mine, have, job, onPick, ai, onChanged }: { mine: readonly Tool[]; have: readonly Have[]; job: Job | null; onPick: (j: Job) => void; ai: ReactNode; onChanged?: () => void }) {
  const navigate = useNavigate();
  const editing = job === "edit" && (mine.includes("media") || mine.includes("editor"));
  const footage = useFootage(editing);
  const [librarySetup, setLibrarySetup] = useState(false);
  const missing = jobNeeds(job, mine, have);
  const noFolders = !!footage.status?.allowed && footage.status.folders.length === 0;
  const libraryOpen = editing && (missing.some(isLibrary) || noFolders);
  // the rows shown since this job was picked: one done here stays on screen, ticked
  const shown = useRef<{ job: Job | null; keys: Set<string>; library: boolean | null }>({ job, keys: new Set(), library: null });
  if (shown.current.job !== job) shown.current = { job, keys: new Set(), library: null };
  for (const n of missing) shown.current.keys.add(key(n));
  if (editing && footage.read && shown.current.library === null) shown.current.library = libraryOpen;
  const rows = jobNeeds(job, mine, []).filter((n) => !isLibrary(n) && shown.current.keys.has(key(n)));
  const showLibrary = editing && !!shown.current.library;
  const waiting = editing && !footage.read;
  const folders = footage.status?.folders ?? [];

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
      {job && !waiting && (rows.length > 0 || showLibrary) && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">Still to set up</p>
          <ul className="divide-y divide-border">
            {showLibrary && (
              <NeedLine
                met={!libraryOpen}
                name={TOOL_NAMES.media}
                line={libraryOpen ? NEED_SENTENCE.library : folders.map((f) => f.path).join(", ") || undefined}
                button={
                  // its own setup, over this window; with no library of her own to set up, the Media Library itself
                  <Button size="sm" variant="outline" className="h-7" onClick={() => (footage.lib ? setLibrarySetup(true) : navigate("/library?setup=1"))}>
                    Set up
                  </Button>
                }
              />
            )}
            {rows.map((n) => (
              <NeedRow key={key(n)} need={n} met={!missing.some((m) => key(m) === key(n))} welcome form={n.form === "ai" ? ai : undefined} />
            ))}
          </ul>
        </div>
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
