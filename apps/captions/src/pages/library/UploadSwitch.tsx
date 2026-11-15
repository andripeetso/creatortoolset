import { useEffect, useState } from "react";
import type { LibrarySummary } from "@contracts/library";
import { Switch } from "@/components/ui/switch";
import { Card, Row, Section } from "@/components/settings/ui";
import { getWatch, listLibraries, updateLibrary } from "@/lib/library";
import { thisMacBridge } from "@/lib/thisMac";

/**
 * The library's upload switch (settings.upload, off by default): in the Mac app with the server elsewhere, a file added
 * to the Media Library is indexed where it is on this Mac (lib/onMac.ts) unless it is on. One stored value, shown in the
 * library's own settings and in Settings → Storage. Anywhere else it changes nothing, so it is not shown there.
 */

export const UPLOAD_LABEL = "Upload video files to the server";

/** Whether the switch does anything here: the Mac app, with a server that does not read this computer's files (`allowed`). */
export const uploadSwitchApplies = (allowed: boolean | undefined) => !!thisMacBridge() && !allowed;

export function UploadSwitch({ library, description, onChange, onError }: { library: LibrarySummary; description?: string; onChange: (l: LibrarySummary) => void; onError: (e: string) => void }) {
  return (
    <Row
      title={UPLOAD_LABEL}
      description={description}
      control={
        <Switch
          aria-label={UPLOAD_LABEL}
          checked={library.settings.upload !== "none"}
          disabled={!!library.readOnly}
          onCheckedChange={(on) =>
            void updateLibrary(library.id, { settings: { upload: on ? "all" : "none" } })
              .then(onChange)
              .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
          }
        />
      }
    />
  );
}

/** Settings → Storage: the switch for each of this workspace's own libraries, in the Mac app with the server elsewhere. */
export function LibraryUploadSection() {
  const [libs, setLibs] = useState<LibrarySummary[] | null>(null);
  const [applies, setApplies] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!thisMacBridge()) return;
    let live = true;
    listLibraries()
      .then(async (all) => {
        const own = all.filter((l) => !l.readOnly);
        const allowed = own[0] ? (await getWatch(own[0].id).catch(() => null))?.allowed : undefined;
        if (live) (setLibs(own), setApplies(uploadSwitchApplies(allowed)));
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => void (live = false);
  }, []);
  if (!applies || !libs?.length) return null;
  return (
    <Section title="Media Library">
      <Card>
        {libs.map((l) => (
          <UploadSwitch
            key={l.id}
            library={l}
            description={libs.length > 1 ? l.name : undefined}
            onChange={(n) => setLibs((all) => all?.map((x) => (x.id === n.id ? n : x)) ?? all)}
            onError={setError}
          />
        ))}
        {error && <Row title={error} />}
      </Card>
    </Section>
  );
}
