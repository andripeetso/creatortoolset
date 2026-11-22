import { useCallback, useEffect, useState } from "react";
import type { LibraryStatus, LibrarySummary, WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Card, ErrorRow, LoadingRow, Row, Section, Status } from "@/components/settings/ui";
import { hiddenLine, leftOutLine, STAGE_NAME, StageRow } from "@/components/LibraryProcessing";
import { getStatus, retryFailed } from "@/lib/library";
import { Made } from "./settings/Made";

const n = (x: number) => x.toLocaleString();
const files = (x: number) => `${n(x)} ${x === 1 ? "file" : "files"}`;

/**
 * The library's Status view (the View menu's Status, and the More menu's Library status): its files against what its
 * folders hold, what is missing or could not be read, each step with what failed and Retry, and What's made (the same
 * list as Settings → Media Library, whose switches `onSettings` opens). What waits for a key or a computer, and the
 * folders that can't be read with Allow, stand above it on the page (LibraryProgressBar, CantRead).
 */
export function LibraryHealth({ library, watch, onSettings }: { library: LibrarySummary; watch: WatchStatus | null; onSettings?: () => void }) {
  const [s, setS] = useState<LibraryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
  const retry = async (kind: string) => {
    setBusy(kind);
    try {
      await retryFailed(library.id, kind);
      await load();
    } catch {
      setError("Could not retry");
    } finally {
      setBusy(null);
    }
  };
  const found = watch?.folders.reduce((t, f) => t + f.files, 0) ?? 0;
  const adding = watch?.folders.reduce((t, f) => t + f.adding, 0) ?? 0;
  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
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
      {!!s?.stages.length && (
        <Section title="Steps">
          <Card>
            <ul className="grid grid-cols-[minmax(0,11rem)_minmax(3rem,1fr)_auto] gap-x-3 gap-y-1.5 px-3 py-3 sm:px-4">
              {s.stages.map((st) => (
                <StageRow key={st.kind} name={STAGE_NAME[st.kind]} done={st.done} of={st.of} failed={st.failed} busy={false} />
              ))}
            </ul>
            {s.stages
              .filter((st) => st.failed > 0)
              .map((st) => (
                <Row
                  key={`f-${st.kind}`}
                  title={STAGE_NAME[st.kind]}
                  status={<Status tone="broken">{`${files(st.failed)} failed`}</Status>}
                  control={
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void retry(st.kind)}>
                      {busy === st.kind ? "Queueing" : "Retry"}
                    </Button>
                  }
                />
              ))}
          </Card>
        </Section>
      )}
      {!library.readOnly && <Made library={library} onSettings={onSettings} />}
    </div>
  );
}
