import { useCallback, useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { failedWords, type LibraryMade, type LibraryStatus, type LibrarySummary, type LibraryUnreadable, type WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Card, ErrorRow, LoadingRow, Row, Section, Status } from "@/components/settings/ui";
import { hiddenLine, leftOutLine } from "@/components/LibraryProcessing";
import { getMade, getStatus, getUnreadable, retryUnreadable, updateLibrary } from "@/lib/library";
import { cn } from "@/lib/utils";
import { healthOf, Made } from "./settings/Made";

const n = (x: number) => x.toLocaleString();
const files = (x: number) => `${n(x)} ${x === 1 ? "file" : "files"}`;

const WORD = { done: "Everything made", waiting: "Waiting", failed: "Failed" } as const;
const DOT = { done: "bg-emerald-500", waiting: "bg-amber-500", failed: "bg-red-500" } as const;

/**
 * The library page's status button: its dot is the library's health at a glance (green: everything made, amber:
 * something waits or is not made, red: something failed), from What's made. Read when the page opens and again when
 * Library status closes (`open` back to false), never on each library change: What's made is a heavy read.
 */
export function LibraryHealthButton({ library, open, onOpen }: { library: LibrarySummary; open: boolean; onOpen: () => void }) {
  const [made, setMade] = useState<LibraryMade[] | null>(null);
  useEffect(() => {
    if (open) return;
    let live = true;
    // a failed read leaves the dot out: the dialog says what failed
    getMade(library.id).then(
      (m) => live && setMade(m),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [library.id, open]);
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
 * and which computer makes it, Retry and Make for the missing (what is made for new files is Settings → Media Library's, which
 * `onSettings` opens). ✕, Esc and a click outside close it; the library stays as it was underneath.
 */
export function LibraryStatusDialog({ library, watch, onClose, onSettings, onOpenClip, onChange }: { library: LibrarySummary; watch: WatchStatus | null; onClose: () => void; onSettings?: () => void; onOpenClip?: (id: string) => void; onChange?: (l: LibrarySummary) => unknown }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle>Library status</DialogTitle>
        <DialogDescription className="sr-only">What the library has made for its files, and what waits</DialogDescription>
        <LibraryHealth library={library} watch={watch} onSettings={onSettings} onOpenClip={onOpenClip} onChange={onChange} />
      </DialogContent>
    </Dialog>
  );
}

function LibraryHealth({ library, watch, onSettings, onOpenClip, onChange }: { library: LibrarySummary; watch: WatchStatus | null; onSettings?: () => void; onOpenClip?: (id: string) => void; onChange?: (l: LibrarySummary) => unknown }) {
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
              {s.unreadable > 0 && <Unreadable library={library} count={s.unreadable} onRetried={() => void load()} onOpenClip={onOpenClip} />}
              {s.leftOut?.map((x) => <Row key={x.computer} title="Trash" description={leftOutLine(x)} />)}
              {s.hidden?.map((x) => <Row key={`h-${x.computer}`} title="Hidden" description={hiddenLine(x)} />)}
            </>
          )}
        </Card>
      </Section>
      {!library.readOnly && (
        <Made library={library} onSettings={onSettings} onBroll={onChange && ((v) => updateLibrary(library.id, { settings: { transcribeBroll: v } }).then(onChange))} />
      )}
    </div>
  );
}

/**
 * The files that failed, opened from their row: each by name with what failed (the tool's own error on hover), a click
 * opens its clip, and Retry queues every failed step of them again (after an update, or with the disk connected).
 */
function Unreadable({ library, count, onRetried, onOpenClip }: { library: LibrarySummary; count: number; onRetried: () => void; onOpenClip?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LibraryUnreadable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const load = useCallback(() => {
    setError(null);
    getUnreadable(library.id).then(setItems, () => setError("Could not load the files"));
  }, [library.id]);
  useEffect(() => {
    if (open && !items) load();
  }, [open, items, load]);
  const retry = () => {
    setRetrying(true);
    retryUnreadable(library.id).then(
      () => {
        setItems(null);
        setOpen(false);
        onRetried();
      },
      () => setError("Could not retry the files"),
    ).finally(() => setRetrying(false));
  };
  return (
    <Row
      title="Unreadable"
      status={<Status tone="broken">{`${files(count)} could not be prepared`}</Status>}
      control={
        <div className="flex gap-2">
          {!library.readOnly && (
            <Button size="sm" variant="outline" disabled={retrying} onClick={retry}>
              Retry
            </Button>
          )}
          <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Show"}
          </Button>
        </div>
      }
    >
      {open && (
        <div className="mt-2 max-h-72 overflow-y-auto rounded-md border border-border">
          {error && <ErrorRow title={error} retry={load} />}
          {!items && !error && <LoadingRow />}
          {items?.map((f) => (
            <div key={f.id} className="flex items-baseline justify-between gap-3 border-b border-border px-3 py-1.5 text-sm last:border-b-0">
              <button type="button" className="min-w-0 truncate text-left hover:underline disabled:no-underline" disabled={!onOpenClip} onClick={() => onOpenClip?.(f.id)}>
                {f.title}
              </button>
              <span title={f.error || undefined} className="shrink-0 text-xs text-red-600 dark:text-red-400">
                {failedWords(f.step, f.error)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Row>
  );
}
