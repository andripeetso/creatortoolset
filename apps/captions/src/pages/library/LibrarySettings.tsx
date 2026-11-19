import { useState } from "react";
import { FOLDER_LABELS } from "@contracts/storage";
import { LIBRARY_WORDS, PROXY_QUALITIES, hostsOriginals, hostsProxies, levelOf, organizeOf, proxyQualityOf, uploadFrom, type LibrarySettings as Settings, type LibrarySpace, type LibraryStorage, type LibrarySummary, type WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Card, Row, Section, Status } from "@/components/settings/ui";
import { updateLibrary, redoMany } from "@/lib/library";
import { thisMacBridge } from "@/lib/thisMac";
import { useWorkspace } from "@/lib/workspace";
import { redoKinds } from "./Selection";
import { thisComputer, storeName } from "../LibraryStorage";
import { LibraryCopies } from "./Copies";
import { MemberSettings } from "./MemberSettings";
import { Effort } from "./settings/Effort";
import { Models } from "./settings/Models";
import { OwnerFolders } from "./settings/OwnerFolders";
import { RadioList } from "./settings/RadioList";

/**
 * The Media Library's settings, the owner's (UNIFIED-PRD §3.1), behind one button beside its search (the sheet) and as
 * Settings → Media Library (the same body, LibrarySettingsBody). In the order the page goes by importance: how imported
 * media behaves, Folders, Organization, Proxy workflow, Hosted media, Analysis, Models, All clips, and Copies last. A
 * viewer who is not the owner gets the member page (./MemberSettings.tsx). The button carries an amber dot while a
 * folder or clip is not found.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface BodyProps {
  library: LibrarySummary;
  watch: WatchStatus;
  /** the library's manual folders (not used on this page since Folders is the workspace's own list; kept for the callers) */
  folders?: unknown[];
  onChange: (l: LibrarySummary) => void;
  onError: (e: string) => void;
}

/** A footage folder or a clip the library cannot find: the page's More button carries a dot. */
export const needsAttention = (watch: WatchStatus) => watch.missing > 0 || watch.folders.some((f) => !f.found);

/** Library settings, a sheet on the right; the page's More menu opens it by that name. */
export function LibrarySettings({ open, onOpenChange, ...body }: BodyProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-scroll p-0 sm:max-w-lg">
        {/* its end scrolls clear of the assistant's button while that is in a bottom corner (it stands over the sheet) */}
        <div className="flex flex-col gap-6 p-4 pt-12 sm:p-6 sm:pt-12 [html:has(button[data-assistant-dock][data-corner^=b])_&]:pb-24">
          <SheetTitle className="text-base">Library settings</SheetTitle>
          <LibrarySettingsBody {...body} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The settings themselves, in the sheet and in Settings → Media Library. `workspace`: the workspace the Folders are read
 * for (Settings' selector); left out, the window's own workspace. A viewer who is not the owner gets the member page.
 */
export function LibrarySettingsBody({ library, watch, onChange, onError, workspace }: BodyProps & { workspace?: string | null }) {
  const windowWorkspace = useWorkspace((s) => s.currentProjectId);
  if (library.readOnly) return <MemberSettings library={library} />;
  const s = library.settings;
  const level = levelOf(s);
  const save = (settings: Partial<Settings>) =>
    updateLibrary(library.id, { settings })
      .then(onChange)
      .catch((e: unknown) => onError(message(e)));
  return (
    <>
      <Section title={LIBRARY_WORDS.importTitle}>
        <Card>
          <RadioList
            name="import-mode"
            value={s.importMode ?? (s.setupAt ? "copy" : "in-place")}
            options={[
              { value: "copy", label: LIBRARY_WORDS.importCopy.label, tip: LIBRARY_WORDS.importCopy.tip },
              { value: "in-place", label: LIBRARY_WORDS.importInPlace.label, tip: LIBRARY_WORDS.importInPlace.tip },
            ]}
            onChange={(v) => void save({ importMode: v })}
          />
        </Card>
      </Section>
      <Section title={LIBRARY_WORDS.foldersTitle}>
        <OwnerFolders library={library} workspace={workspace === undefined ? windowWorkspace : workspace} onChange={onChange} onError={onError} />
      </Section>
      <Section title={LIBRARY_WORDS.organizationTitle}>
        <Organization settings={s} level={level} save={save} />
      </Section>
      <Section title={LIBRARY_WORDS.proxyTitle}>
        <Proxies library={library} save={save} />
      </Section>
      <Section title={LIBRARY_WORDS.hostedTitle}>
        <Hosted library={library} watch={watch} save={save} />
      </Section>
      <Section title={LIBRARY_WORDS.analysisTitle}>
        <Effort library={library} save={save} />
      </Section>
      {level !== "off" && (
        <Section title={LIBRARY_WORDS.modelsTitle}>
          <Models settings={s} save={save} />
        </Section>
      )}
      <RedoAll library={library} onError={onError} />
      <LibraryCopies libraryId={library.id} />
    </>
  );
}

/** Smart folders (the default) or Organize yourself. Smart folders needs Analysis: at Off it is disabled, a stored choice kept. */
function Organization({ settings, level, save }: { settings: Settings; level: string; save: (s: Partial<Settings>) => Promise<unknown> }) {
  const off = level === "off";
  const smart = LIBRARY_WORDS.smartFolders;
  return (
    <Card>
      <RadioList
        name="organize"
        value={organizeOf(settings.organize) ?? "ai"}
        options={[
          {
            value: "ai",
            label: smart.label,
            tip: off ? `${smart.tip} ${LIBRARY_WORDS.smartFoldersOff}` : smart.tip,
            disabled: off,
            status: off ? <Status>{LIBRARY_WORDS.analysisOff}</Status> : undefined,
          },
          { value: "own", label: LIBRARY_WORDS.organizeYourself.label, tip: LIBRARY_WORDS.organizeYourself.tip },
        ]}
        onChange={(v) => void save({ organize: v })}
      />
    </Card>
  );
}

/** Generate proxies (forced on while Hosted media hosts proxies) and the quality, shown while it is on. */
function Proxies({ library, save }: { library: LibrarySummary; save: (s: Partial<Settings>) => Promise<unknown> }) {
  const hosted = hostsProxies(library.settings.upload);
  const on = hosted || library.settings.proxy;
  const gen = LIBRARY_WORDS.generateProxies;
  return (
    <Card>
      <Row
        title={gen.label}
        tip={gen.tip}
        status={hosted ? <Status>{LIBRARY_WORDS.proxiesHostedOn}</Status> : undefined}
        control={<Switch aria-label={gen.label} checked={on} disabled={hosted} onCheckedChange={(v) => void save({ proxy: v })} />}
      />
      {on && (
        <>
          <Row title={LIBRARY_WORDS.proxyQuality.label} tip={LIBRARY_WORDS.proxyQuality.tip} />
          <RadioList
            name="proxy-quality"
            value={proxyQualityOf(library.settings.proxyQuality)}
            options={PROXY_QUALITIES.map((q) => ({ value: q.value, label: q.label }))}
            onChange={(v) => void save({ proxyQuality: v })}
          />
        </>
      )}
    </Card>
  );
}

/**
 * Hosted media: the master (Upload to server, which turns Proxies on), Originals and Proxies while it is on, and Final
 * exports as its own switch (independent of the master). On This Mac, with the server on this computer, the master is off
 * and disabled: there is no server to upload to.
 */
function Hosted({ library, watch, save }: { library: LibrarySummary; watch: WatchStatus; save: (s: Partial<Settings>) => Promise<unknown> }) {
  const u = library.settings.upload;
  const originals = hostsOriginals(u);
  const proxies = hostsProxies(u);
  const master = originals || proxies;
  const noServer = !!thisMacBridge() && watch.allowed;
  const finals = library.settings.finalsUpload ?? "all";
  const finalsOn = hostsOriginals(finals) || hostsProxies(finals);
  return (
    <Card>
      <Row
        title={LIBRARY_WORDS.uploadToServer}
        status={noServer ? <Status>{LIBRARY_WORDS.noServer}</Status> : undefined}
        control={<Switch aria-label={LIBRARY_WORDS.uploadToServer} checked={master && !noServer} disabled={noServer} onCheckedChange={(on) => void save({ upload: uploadFrom(false, on) })} />}
      />
      {master && (
        <>
          <Row title={LIBRARY_WORDS.originals} control={<Switch aria-label={LIBRARY_WORDS.originals} checked={originals} onCheckedChange={(on) => void save({ upload: uploadFrom(on, proxies) })} />} />
          <Row title={LIBRARY_WORDS.proxies} control={<Switch aria-label={LIBRARY_WORDS.proxies} checked={proxies} onCheckedChange={(on) => void save({ upload: uploadFrom(originals, on) })} />} />
        </>
      )}
      <Row
        title={FOLDER_LABELS.library}
        tip={LIBRARY_WORDS.finalExportsUpload.tip}
        control={<Switch aria-label={FOLDER_LABELS.library} checked={finalsOn} onCheckedChange={(on) => void save({ finalsUpload: on ? (finals === "none" ? "all" : finals) : "none" })} />}
      />
    </Card>
  );
}

/**
 * Redo for all clips: descriptions, transcripts or search data made again for the whole library, on the person's own
 * AI provider. A press asks once more in its own row, saying how many clips it is, before anything runs.
 */
function RedoAll({ library, onError }: Pick<BodyProps, "library" | "onError">) {
  const [asking, setAsking] = useState<{ kind: string; clips: number } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const ask = (kind: string) =>
    redoMany(library.id, [kind], undefined, true).then(
      (r) => (setDone(null), setAsking({ kind, clips: r.clips })),
      (e: unknown) => onError(message(e)),
    );
  const run = (kind: string) =>
    redoMany(library.id, [kind]).then(
      () => (setAsking(null), setDone(kind)),
      (e: unknown) => onError(message(e)),
    );
  return (
    <Section title={LIBRARY_WORDS.redoTitle}>
      <Card>
        {redoKinds(library.settings).map((r) => (
          <Row
            key={r.kind}
            title={r.label}
            status={asking?.kind === r.kind ? <Status>{LIBRARY_WORDS.forClips(asking.clips)}</Status> : done === r.kind ? <Status>{LIBRARY_WORDS.started}</Status> : null}
            control={
              asking?.kind === r.kind ? (
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>
                    {LIBRARY_WORDS.cancel}
                  </Button>
                  <Button size="sm" disabled={!asking.clips} onClick={() => void run(r.kind)}>
                    {LIBRARY_WORDS.redoAll}
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={() => void ask(r.kind)}>
                  {LIBRARY_WORDS.redo}
                </Button>
              )
            }
          />
        ))}
      </Card>
    </Section>
  );
}

const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : "under 1 MB");
const files = (n: number) => `${n.toLocaleString()} ${n === 1 ? "file" : "files"}`;

/**
 * Where the library's videos are, in a few words (api/library/space.ts videos): on a Mac and not uploaded, read where
 * they are on this computer, or stored by the server (its disk or a bucket, with the size). An empty library says
 * where new files go. `onMac`: the Mac app with the server elsewhere, and its upload switch. Read by LibraryStorage.test.
 */
export function videoPlace(v: LibrarySpace["videos"], o: { saved: LibraryStorage | null; onThisComputer: boolean; onMac: { upload: boolean } | null }): string {
  const here = thisComputer();
  const cloud = o.saved && o.saved.kind !== "local" && !o.saved.proxies ? storeName(o.saved) : null;
  const stored = cloud ? `uploaded to ${cloud}` : o.onThisComputer ? `on ${here}` : "uploaded to the server";
  const mac = thisMacBridge() ? "this Mac" : "a Mac";
  if (!v.onMac && !v.inPlace && !v.stored.files) {
    const next = o.onMac && !o.onMac.upload ? `on ${mac}, not uploaded` : stored;
    return next[0]!.toUpperCase() + next.slice(1);
  }
  return [
    v.onMac ? `${files(v.onMac)} on ${mac}, not uploaded` : "",
    v.inPlace ? `${files(v.inPlace)} on ${here}` : "",
    v.stored.files ? `${files(v.stored.files)} ${stored}, ${size(v.stored.bytes)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * What the Upload to the server row says of the video files in place of its own sentence: how many are where, or the
 * bucket new ones go to by its name. Nothing while that sentence says it all (an empty library with no bucket).
 */
export function videoFacts(v: LibrarySpace["videos"], o: Parameters<typeof videoPlace>[1]): string | undefined {
  const bucket = !!o.saved && o.saved.kind !== "local" && !o.saved.proxies;
  return v.onMac || v.inPlace || v.stored.files || bucket ? videoPlace(v, o) : undefined;
}
