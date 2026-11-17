import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { folderTo } from "@/pages/library/folders";
import { useCachedLoad } from "@/lib/local-cache";
import { Card, ErrorRow, ListRow, LoadingRow, Section, WorkspacePick, inWorkspace, useSettingsWorkspace } from "./ui";
import { useOwnWorkspaces } from "./WorkspaceDetailsSection";

/** What GET /api/sfx answers (api/library/sfx.ts). */
export interface SfxState {
  library: string | null;
  count: number;
  folder: string | null;
  starter: { total: number; installed: number };
  packs: { name: string; source: string; license: string; licenseFile: string }[];
  available: boolean;
}

async function call<T>(url: string, method: string, workspace: string | null): Promise<T> {
  const r = await fetch(url, inWorkspace(workspace, { method }));
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body;
}

/**
 * Settings → Sound effects (the Workspace group): the workspace's Sound effects folder, the starter set (the CC0 sounds the
 * app ships, Install and Remove) and where the sounds come from. Every request names the workspace shown.
 */
export function SoundEffectsSection() {
  const own = useOwnWorkspaces();
  const w = useSettingsWorkspace("one", own);
  const state = useCachedLoad<SfxState>("/api/sfx", () => call<SfxState>("/api/sfx", "GET", w.id), { own: true, workspace: w.cacheKey });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const change = async (method: "POST" | "DELETE") => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await call<{ added?: number; removed?: number; kept?: number }>("/api/sfx/starter", method, w.id);
      setNote(method === "POST" ? (r.added ? `Added ${r.added}` : "Already in your library") : `Removed ${r.removed ?? 0}${r.kept ? `, kept ${r.kept} changed` : ""}`);
      await state.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!state.data) {
    return (
      <>
        <WorkspacePick mode="one" only={own} />
        <Section title="Sound effects">
          <Card>{state.error ? <ErrorRow title="Could not load sound effects" detail={state.error} retry={() => void state.refresh().catch(() => {})} /> : <LoadingRow />}</Card>
        </Section>
      </>
    );
  }
  const s = state.data;
  const installed = s.starter.installed;
  return (
    <>
      <WorkspacePick mode="one" only={own} />
      {error && (
        <Card>
          <ErrorRow title="Could not change the starter set" detail={error} />
        </Card>
      )}
      <Section title="Your library">
        <Card>
          <ListRow
            title="Sound effects"
            subtitle={s.library ? `${s.count} ${s.count === 1 ? "sound" : "sounds"}` : "No Media Library here"}
            actions={s.folder ? <Button asChild variant="outline" size="sm"><Link to={folderTo(s.folder)}>Open folder</Link></Button> : undefined}
          />
        </Card>
      </Section>
      <Section title="Starter set">
        <Card>
          <ListRow
            title="Starter set"
            subtitle={`${s.starter.total} CC0 sounds from the packs below`}
            status={note ?? (installed ? `Installed ${installed} of ${s.starter.total}` : undefined)}
            actions={
              <>
                {installed > 0 && (
                  <Button variant="outline" size="sm" disabled={busy || !s.library} onClick={() => void change("DELETE")}>
                    Remove
                  </Button>
                )}
                {installed < s.starter.total && (
                  <Button size="sm" disabled={busy || !s.library || !s.available} onClick={() => void change("POST")}>
                    Install
                  </Button>
                )}
              </>
            }
          />
        </Card>
      </Section>
      <Section title="Sources">
        <Card>
          {s.packs.map((p) => (
            <ListRow
              key={p.name}
              title={p.name}
              subtitle={`Kenney · ${p.license} licence`}
              actions={
                <Button asChild variant="outline" size="sm">
                  <a href={p.source} target="_blank" rel="noreferrer">
                    Source
                  </a>
                </Button>
              }
            />
          ))}
        </Card>
      </Section>
    </>
  );
}
