import { useState } from "react";
import type { Collection, LibrarySummary, WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { createLibrary, getWatch, isFinals, listCollections, listLibraries } from "@/lib/library";
import { holdsClips } from "@/pages/library/folders";
import { useCachedLoad } from "@/lib/local-cache";
import { LibrarySettingsBody } from "@/pages/library/LibrarySettings";
import { Card, ErrorRow, LoadingRow, Row, Section } from "./ui";

/**
 * Settings → Media Library: the current workspace's own library's settings, the same body as the library's own sheet
 * (pages/library/LibrarySettings.tsx). A workspace with no library yet gets Create library, as the Media Library page does.
 */
export function MediaLibrarySection() {
  const libs = useCachedLoad<LibrarySummary[]>("/api/library", listLibraries);
  const library = libs.data?.find((l) => !l.readOnly) ?? null;
  const id = library?.id;
  const watch = useCachedLoad<WatchStatus>(id ? `/api/library/${id}/watch` : null, () => getWatch(id!));
  const folders = useCachedLoad<Collection[]>(id ? `/api/library/${id}/collections` : null, () => listCollections(id!), { own: true });
  const [error, setError] = useState<string | null>(null);
  const saved = (l: LibrarySummary) => libs.set((all) => all?.map((x) => (x.id === l.id ? l : x)) ?? all);

  if (libs.data && !library) {
    return (
      <Section title="Media Library">
        <Card>
          <Row
            title="No library in this workspace yet"
            control={
              <Button size="sm" variant="outline" onClick={() => void createLibrary("Library").then((l) => libs.set((all) => [...(all ?? []), l]), (e: unknown) => setError(e instanceof Error ? e.message : String(e)))}>
                Create library
              </Button>
            }
          />
          {error && <ErrorRow title={error} />}
        </Card>
      </Section>
    );
  }
  if (!library || !watch.data) {
    const failed = libs.error || watch.error;
    return (
      <Section title="Media Library">
        <Card>{failed ? <ErrorRow title="Could not load the Media Library" detail={failed} retry={() => void libs.refresh().catch(() => {})} /> : <LoadingRow />}</Card>
      </Section>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {error && <ErrorRow title={error} />}
      <LibrarySettingsBody library={library} watch={watch.data} folders={(folders.data ?? []).filter((c) => holdsClips(c) && !isFinals(c))} onChange={saved} onError={setError} />
    </div>
  );
}
