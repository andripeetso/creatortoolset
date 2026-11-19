import { useEffect, useState } from "react";
import type { Collection, LibrarySummary, WatchStatus } from "@contracts/library";
import { scopeRequests } from "@/lib/current-workspace";
import { getWatch, isFinals, listCollections } from "@/lib/library";
import { holdsClips } from "@/pages/library/folders";
import { useCachedLoad } from "@/lib/local-cache";
import { useWorkspace } from "@/lib/workspace";
import { LibrarySettingsBody } from "@/pages/library/LibrarySettings";
import { Card, EmptyRow, ErrorRow, LoadingRow, Section, WorkspacePick, inWorkspace, useSettingsWorkspace } from "./ui";
import { useOwnWorkspaces } from "./WorkspaceDetailsSection";

/** The libraries of one workspace (GET /api/library answers for the workspace the request names). */
const librariesOf = (workspace: string | null) =>
  fetch("/api/library", inWorkspace(workspace)).then(async (r) => {
    const body = (await r.json().catch(() => ({}))) as { libraries?: LibrarySummary[]; error?: string };
    if (!r.ok || !body.libraries) throw new Error(body.error ?? `Request failed (${r.status})`);
    return body.libraries;
  });

/**
 * Settings → Media Library (the Workspace group): the settings of the library of the workspace the selector shows, the
 * same body as the library's own sheet (pages/library/LibrarySettings.tsx) without what Settings → Folders owns. Each of
 * the person's own workspaces has a library (the server makes it on the first read); one the team's owner gave them has
 * the owner's library, which is not theirs to set, so it is not offered.
 */
export function MediaLibrarySection() {
  const own = useOwnWorkspaces();
  const w = useSettingsWorkspace("one", own);
  const here = useWorkspace((s) => s.currentProjectId);
  const libs = useCachedLoad<LibrarySummary[]>("/api/library", () => librariesOf(w.id), { workspace: w.cacheKey });
  // the owner's library when the list has one; a workspace the team's owner gave this person shows the member page
  const library = libs.data?.find((l) => !l.readOnly) ?? libs.data?.[0] ?? null;
  const id = library?.id;
  // every request for this library says the workspace shown, whatever the window is in. Set while drawing, before the
  // rows below fetch in their effects
  const prefix = id ? `/api/library/${id}` : null;
  if (prefix) scopeRequests(prefix, w.id && w.id !== here ? w.id : null);
  useEffect(() => () => void (prefix && scopeRequests(prefix, null)), [prefix]);
  const watch = useCachedLoad<WatchStatus>(id ? `/api/library/${id}/watch` : null, () => getWatch(id!), { workspace: w.cacheKey });
  const folders = useCachedLoad<Collection[]>(id ? `/api/library/${id}/collections` : null, () => listCollections(id!), { own: true, workspace: w.cacheKey });
  const [error, setError] = useState<string | null>(null);
  const saved = (l: LibrarySummary) => libs.set((all) => all?.map((x) => (x.id === l.id ? l : x)) ?? all);

  if (!library || !watch.data) {
    const failed = libs.error || watch.error;
    return (
      <>
        <WorkspacePick mode="one" only={own} />
        <Section title="Media Library">
          <Card>
            {failed ? (
              <ErrorRow title="Could not load the Media Library" detail={failed} retry={() => void libs.refresh().catch(() => {})} />
            ) : libs.data && !library ? (
              <EmptyRow title="No library" />
            ) : (
              <LoadingRow />
            )}
          </Card>
        </Section>
      </>
    );
  }
  return (
    <>
      <WorkspacePick mode="one" only={own} />
      {error && (
        <Card>
          <ErrorRow title={error} />
        </Card>
      )}
      {/* keyed by the library: another workspace's starts from its own values */}
      <LibrarySettingsBody key={library.id} library={library} watch={watch.data} workspace={w.id} onChange={saved} onError={setError} />
    </>
  );
}
