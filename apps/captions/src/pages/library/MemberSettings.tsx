import { useEffect, useState } from "react";
import { hostsOriginals, hostsProxies, type LibrarySummary, type LibraryUpload } from "@contracts/library";
import type { StorageView } from "@contracts/storage";
import type { ServerWorkView } from "@contracts/work";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, Row, Section } from "@/components/settings/ui";
import { AddFolderDialog, call, getStorage } from "@/components/settings/StorageRows";
import { thisMacDevice, useProviders } from "@/lib/providers";
import { downloadsOf, setDownloads, useOffline, type Downloads } from "./offline-state";

/**
 * A member's Settings → Media Library (UNIFIED-PRD §3.2): the workspace's settings as the owner set them, read only; the
 * person's own Downloads (the Mac app); and the folders on this computer, located, never set up here. Copy: SCREENS-COPY §2.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const HOSTED: Record<LibraryUpload, string> = { none: "Off", originals: "Originals", proxies: "Proxies", all: "Originals and proxies" };

/** Hosted media in words: the owner's Upload to server, and " and final exports" when Final exports is on. */
export function hostedWords(s: LibrarySummary["settings"]): string {
  const finals = !!s.finalsUpload && s.finalsUpload !== "none";
  if (!hostsOriginals(s.upload) && !hostsProxies(s.upload)) return finals ? "Final exports" : HOSTED.none;
  return finals ? `${HOSTED[s.upload]} and final exports` : HOSTED[s.upload];
}

/**
 * Downloads (M13): Automatic downloads and Make available offline, tied together; the kinds are the workspace's hosted
 * ones. Mac app only, and hidden while Hosted media is Off (there is nothing to download).
 */
export function DownloadsCard({ library }: { library: LibrarySummary }) {
  const offline = useOffline();
  const [error, setError] = useState("");
  const upload = library.settings.upload;
  const hosted = { originals: hostsOriginals(upload), proxies: hostsProxies(upload) };
  if (!thisMacDevice() || (!hosted.originals && !hosted.proxies)) return null;
  const d = downloadsOf(offline, library.id);
  const auto = d.mode !== "none";
  const keep = d.mode === "all";
  const save = (next: Downloads) => setDownloads(library.id, next).then(() => setError(""), (e: unknown) => setError(message(e)));
  // at least one kind stays on while offline is on (the server refuses neither off)
  const kind = (k: "proxies" | "originals", title: string) => {
    const on = keep && hosted[k] && !!d[k];
    const other = k === "proxies" ? hosted.originals && !!d.originals : hosted.proxies && !!d.proxies;
    return (
      <Row
        title={title}
        status={hosted[k] ? undefined : "Not hosted"}
        control={
          <Switch
            aria-label={title}
            checked={on}
            disabled={!hosted[k] || (on && !other)}
            onCheckedChange={(v) => void save({ mode: "all", proxies: k === "proxies" ? v : !!d.proxies, originals: k === "originals" ? v : !!d.originals })}
          />
        }
      />
    );
  };
  return (
    <Section title="Downloads">
      <Card>
        <Row
          title="Automatic downloads"
          tip="Downloads only the files an edit on your computer needs. When the cache is full, the files used longest ago are removed. Off: clips stream from the server and nothing is kept unless you download it."
          control={<Switch aria-label="Automatic downloads" checked={auto} onCheckedChange={(v) => void save({ mode: v ? "needed" : "none" })} />}
        />
        <Row
          title="Make available offline"
          tip="Downloads this workspace's hosted media to your computers and keeps it up to date."
          control={
            <Switch
              aria-label="Make available offline"
              checked={keep}
              onCheckedChange={(v) => void save(v ? { mode: "all", proxies: hosted.proxies, originals: hosted.originals } : { mode: "needed" })}
            />
          }
        />
        {keep && kind("proxies", "Proxies")}
        {keep && kind("originals", "Originals")}
      </Card>
      {error && <p className="pt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </Section>
  );
}

const FOLDERS = [
  { role: "footage", title: "Source media", tip: "Folders on this computer that already hold this workspace's media. Clips found there play from here; nothing new is imported." },
  { role: "projects", title: "Project files", tip: "Where project work is saved: edits, renders and test renders." },
  { role: "library", title: "Final exports", tip: "Where finished, clean exports are saved." },
] as const;

type FolderRole = (typeof FOLDERS)[number]["role"];

/**
 * The owner's Downloads (M13), on a computer with no Source media folder for the workspace: a computer that reads the
 * footage itself needs no copy, so the card is only for the others. The folder list is the window workspace's.
 */
export function OwnerDownloads({ library }: { library: LibrarySummary }) {
  const [storage, setStorage] = useState<StorageView | null>(null);
  useEffect(() => void getStorage().then(setStorage, () => {}), []);
  const here = thisMacDevice();
  if (!storage || !here || (storage.folders ?? []).some((f) => f.role === "footage" && f.origin.host === here)) return null;
  return <DownloadsCard library={library} />;
}

export function MemberSettings({ library }: { library: LibrarySummary }) {
  const [view, setView] = useState<ServerWorkView | null>(null);
  const [storage, setStorage] = useState<StorageView | null>(null);
  useEffect(() => void call<ServerWorkView>("/api/work/server-work").then(setView, () => {}), []);
  useEffect(() => void getStorage().then(setStorage, () => {}), []);
  const providers = useProviders();
  const [adding, setAdding] = useState<FolderRole | null>(null);
  const here = thisMacDevice();
  // this member's own folders, on this computer only: shown, located here, never set up for anyone else
  const mine = (role: string) => (storage && here ? storage.folders.filter((f) => f.role === role && f.origin.host === here) : []);
  const reload = () => void getStorage().then(setStorage, () => {});
  return (
    <div className="flex flex-col gap-6">
      {!library.settings.setupAt && <p className="text-sm text-muted-foreground">This Media Library isn't set up yet.</p>}
      <Section title="Workspace settings">
        <Card className="border-primary/30 bg-primary/5">
          {view?.serverName && <Row title="Server" control={view.serverName} />}
          <Row title="Hosted media" control={hostedWords(library.settings)} />
          {view?.workspace && (
            <Row
              title="Server rendering"
              tip="On: video work for this workspace runs on the server. Off: it runs on your computer."
              control={view.workspace.rendering ? "On" : "Off"}
            />
          )}
        </Card>
      </Section>
      <DownloadsCard library={library} />
      {here && (
        <Section title="Folders">
          <Card>
            {FOLDERS.map((f) => {
              const own = mine(f.role);
              // Source media takes any number of folders; the other two are one each, "Not set" until chosen
              const add = f.role === "footage" || !own.length;
              return (
                <Row
                  key={f.role}
                  title={f.title}
                  tip={f.tip}
                  status={!own.length && storage && f.role !== "footage" ? "Not set" : undefined}
                  description={own.map((x) => x.origin.path).join(", ") || undefined}
                  control={
                    add ? (
                      <Button size="sm" variant="outline" onClick={() => setAdding(f.role)}>
                        {f.role === "footage" ? "Add folder…" : "Set…"}
                      </Button>
                    ) : undefined
                  }
                />
              );
            })}
            <AddFolderDialog
              open={adding !== null}
              onOpenChange={(o) => !o && setAdding(null)}
              role={adding ?? "footage"}
              devices={(providers.data?.devices ?? []).filter((d) => d.id === here)}
              serverDisks={storage?.serverDisks}
              here={storage?.here}
              onChanged={reload}
            />
          </Card>
        </Section>
      )}
    </div>
  );
}
