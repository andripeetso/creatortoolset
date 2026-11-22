import { useCallback, useEffect, useRef, useState } from "react";
import { Activity } from "lucide-react";
import type { LibraryMade, LibraryStatus, LibrarySummary, WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Card, ErrorRow, LoadingRow, Row, Section, Status } from "@/components/settings/ui";
import { hiddenLine, leftOutLine } from "@/components/LibraryProcessing";
import { getMade, getStatus } from "@/lib/library";
import { useCachedLoad } from "@/lib/local-cache";
import { cn } from "@/lib/utils";
import { healthOf, Made } from "./settings/Made";

const n = (x: number) => x.toLocaleString();
const files = (x: number) => `${n(x)} ${x === 1 ? "file" : "files"}`;

const WORD = { done: "Everything made", waiting: "Waiting", failed: "Failed" } as const;
const DOT = { done: "bg-emerald-500", waiting: "bg-amber-500", failed: "bg-red-500" } as const;

/**
 * The library page's status button: its dot is the library's health at a glance (green: everything made, amber:
 * something waits or is not made, red: something failed), from What's made. Pressed, it opens Library status; read
 * again when that closes (`open` back to false), for what was made or retried there.
 */
export function LibraryHealthButton({ library, open, onOpen }: { library: LibrarySummary; open: boolean; onOpen: () => void }) {
  const { data: made, refresh } = useCachedLoad<LibraryMade[]>(`/api/library/${library.id}/made`, () => getMade(library.id));
  const was = useRef(open);
  useEffect(() => {
    if (was.current && !open) void refresh();
    was.current = open;
  }, [open, refresh]);
  const tone = made ? healthOf(made, library) : null;
  const label = tone ? `Library status: ${WORD[tone]}` : "Library status";
  return (
    <Button variant="ghost" size="sm" className="relative h-8 w-8 p-0" title={label} aria-label={label} onClick={onOpen}>
      <Activity className="h-4 w-4" />
      {tone && <span aria-hidden className={cn("absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-background", DOT[tone])} />}
    </Button>
  );
}

/**
 * Library status, a dialog over the library (More → Library status, and the status button): its files against what
 * its folders hold, what is missing or could not be read, and What's made: every kind with its state, what it waits for
 * and which computer makes it, Retry and Make for the missing (the same list as Settings → Media Library, whose
 * switches `onSettings` opens). ✕, Esc and a click outside close it; the library stays as it was underneath.
 */
export function LibraryStatusDialog({ library, watch, onClose, onSettings }: { library: LibrarySummary; watch: WatchStatus | null; onClose: () => void; onSettings?: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle>Library status</DialogTitle>
        <DialogDescription className="sr-only">What the library has made for its files, and what waits</DialogDescription>
        <LibraryHealth library={library} watch={watch} onSettings={onSettings} />
      </DialogContent>
    </Dialog>
  );
}

function LibraryHealth({ library, watch, onSettings }: { library: LibrarySummary; watch: WatchStatus | null; onSettings?: () => void }) {
  const [s, setS] = useState<LibraryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    return getStatus(library.id).then(setS, () => setError("Could not load the status"));
  }, [library.id]);
  useEffect(() => {
    let live = true;
    getStatus(library.id).then(
      (x) => live && setS(x),
      () => live && setError("Could not load the status"),
    );
    return () => {
      live = false;
    };
  }, [library.id]);
  const found = watch?.folders.reduce((t, f) => t + f.files, 0) ?? 0;
  const adding = watch?.folders.reduce((t, f) => t + f.adding, 0) ?? 0;
  return (
    <div className="flex w-full flex-col gap-6">
      <Section title="Files">
        <Card>
          {error && <ErrorRow title={error} retry={() => void load()} />}
          {!s && !error && <LoadingRow />}
          {s && (
            <>
              <Row title="Indexed" description={watch?.folders.length ? `${files(s.clips)} · ${n(found)} found in folders` : files(s.clips)} />
              {adding > 0 && <Row title="Still to add" description={files(adding)} />}
              {!!watch?.missing && <Row title="Missing here" status={<Status tone="attention">{`${files(watch.missing)} not found in their folders`}</Status>} />}
              {s.unreadable > 0 && <Row title="Unreadable" status={<Status tone="broken">{`${files(s.unreadable)} could not be read as video or sound`}</Status>} />}
              {s.leftOut?.map((x) => <Row key={x.computer} title="Trash" description={leftOutLine(x)} />)}
              {s.hidden?.map((x) => <Row key={`h-${x.computer}`} title="Hidden" description={hiddenLine(x)} />)}
            </>
          )}
        </Card>
      </Section>
      {!library.readOnly && <Made library={library} onSettings={onSettings} />}
    </div>
  );
}
