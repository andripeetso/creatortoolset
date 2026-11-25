import { LIBRARY_WORDS, PROXY_QUALITIES, hostedOf, hostedSettings, levelOf, makesProxies, organizeOf, proxyQualityOf, type LibrarySettings as Settings, type LibrarySpace, type LibraryStorage, type LibrarySummary, type WatchStatus } from "@contracts/library";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Card, Row, Section, Status, markSave } from "@/components/settings/ui";
import { chooseDialog } from "@/lib/dialogs";
import { getMade, updateLibrary } from "@/lib/library";
import { undoable } from "@/lib/undo";
import { thisMacBridge } from "@/lib/thisMac";
import { useWorkspace } from "@/lib/workspace";
import { useAuth, useMe } from "@/lib/auth";
import { faceBlurOn } from "./face-blur";
import { thisComputer, storeName } from "../LibraryStorage";
import { LibraryCopies } from "./Copies";
import { MemberSettings, OwnerDownloads } from "./MemberSettings";
import { Effort } from "./settings/Effort";
import { Made } from "./settings/Made";
import { Models } from "./settings/Models";
import { OwnerFolders } from "./settings/OwnerFolders";
import { RadioList } from "./settings/RadioList";
import { HostedSwitches } from "./settings/Hosted";

/**
 * The Media Library's settings, the owner's (UNIFIED-PRD §3.1), behind one button beside its search (the sheet) and as
 * Settings → Media Library (the same body, LibrarySettingsBody). In the order the page goes by importance: how imported
 * media behaves, Folders, Organization, Proxy workflow, Hosted media, Analysis, What's made, Models, and Copies last. A
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
export function LibrarySettingsBody({ library, onChange, onError, workspace }: BodyProps & { workspace?: string | null }) {
  const windowWorkspace = useWorkspace((s) => s.currentProjectId);
  const me = useMe();
  const faceBlur = useWorkspace((st) => faceBlurOn(me, st.pluginsOff, workspace ?? st.currentProjectId));
  if (library.readOnly) return <MemberSettings library={library} />;
  const s = library.settings;
  const level = levelOf(s);
  // true once the server has it
  const save = (settings: Partial<Settings> & { blurExisting?: boolean }) =>
    markSave(updateLibrary(library.id, { settings }))
      .then((l) => (onChange(l), true))
      .catch((e: unknown) => (onError(message(e)), false));
  // Generate proxies, the one switch (Proxy workflow, and What's made's Proxies row). Off turns Upload's Proxies part off
  // in the same save (its row goes with it, ./settings/Hosted.tsx); that part cannot be seen any more, so Undo puts both back.
  const setProxy = async (v: boolean) => {
    const was = hostedOf(s);
    const both = !v && was.proxies;
    if ((await save({ proxy: v, ...(both ? hostedSettings({ ...was, proxies: false }, s.finalsUpload) : {}) })) && both)
      undoable(LIBRARY_WORDS.proxiesOff, () => save({ proxy: true, ...hostedSettings(was, s.finalsUpload) }));
  };
  // Blur faces, the one switch (Proxy workflow, and What's made's Blurred copies row). Turning it on asks once whether
  // the files already here are blurred too (blurExisting) or left as they are; either way the Blurred part of Upload
  // (the mix's originals) starts off, and no other setting changes.
  const setBlur = async (v: boolean) => {
    // nothing to ask where every file here has its answer (blurred, kept as filmed, no face found); a failed count asks anyway
    const missing = v ? (await getMade(library.id).catch(() => null))?.find((m) => m.kind === "blur")?.missing : 0;
    const existing = missing === 0 ? "other" : await chooseDialog({ title: LIBRARY_WORDS.blurExisting.title, ok: LIBRARY_WORDS.blurExisting.yes, other: LIBRARY_WORDS.blurExisting.no });
    if (!existing) return;
    await save({ blurFaces: v, ...(v ? { blurExisting: existing === "ok" } : {}), ...hostedSettings({ ...hostedOf(s), originals: false }, s.finalsUpload) });
  };
  return (
    <>
      <Section title={LIBRARY_WORDS.foldersTitle}>
        <OwnerFolders library={library} workspace={workspace === undefined ? windowWorkspace : workspace} onChange={onChange} onError={onError} />
      </Section>
      <Section title={LIBRARY_WORDS.organizationTitle}>
        <Organization settings={s} save={save} />
      </Section>
      <Section title={LIBRARY_WORDS.proxyTitle}>
        <Proxies library={library} save={save} faceBlur={faceBlur} setBlur={(v) => void setBlur(v)} setProxy={(v) => void setProxy(v)} />
      </Section>
      <Section title={LIBRARY_WORDS.hostedTitle}>
        <Hosted library={library} save={save} />
      </Section>
      <OwnerDownloads library={library} />
      <Section title={LIBRARY_WORDS.analysisTitle}>
        <Effort library={library} save={save} />
      </Section>
      <Made library={library} save={save} faceBlur={faceBlur} onBlur={(v) => void setBlur(v)} onProxy={(v) => void setProxy(v)} />
      {level !== "off" && (
        <Section title={LIBRARY_WORDS.modelsTitle}>
          <Models settings={s} save={save} />
        </Section>
      )}
      <LibraryCopies libraryId={library.id} />
    </>
  );
}

/** Smart folders (the default) or Organize yourself. Smart folders file by shoot with no AI, so they work at every Effort (api/library/shoots.ts). */
function Organization({ settings, save }: { settings: Settings; save: (s: Partial<Settings>) => Promise<unknown> }) {
  const smart = LIBRARY_WORDS.smartFolders;
  return (
    <Card>
      <RadioList
        name="organize"
        value={organizeOf(settings.organize) ?? "ai"}
        options={[
          { value: "ai", label: smart.label, tip: smart.tip },
          { value: "own", label: LIBRARY_WORDS.organizeYourself.label, tip: LIBRARY_WORDS.organizeYourself.tip },
        ]}
        onChange={(v) => void save({ organize: v })}
      />
    </Card>
  );
}

/**
 * Proxy workflow, in the order of the chain (Original → Blurred copy → Proxy). Blur faces (with Face Blur on in this
 * workspace, or to turn an old one off) and Generate proxies are two switches, and neither changes the other: under Blur
 * faces a clip's proxy is made from its blurred copy. Proxy quality shows while proxies are made.
 */
function Proxies({ library, save, faceBlur, setBlur, setProxy }: { library: LibrarySummary; save: (s: Partial<Settings>) => Promise<unknown>; faceBlur: boolean; setBlur: (on: boolean) => void; setProxy: (on: boolean) => void }) {
  const s = library.settings;
  const on = makesProxies(s);
  const gen = LIBRARY_WORDS.generateProxies;
  const blur = LIBRARY_WORDS.blurFaces;
  return (
    <Card>
      {(faceBlur || s.blurFaces) && <Row title={blur.label} tip={blur.tip} control={<Switch aria-label={blur.label} checked={!!s.blurFaces} onCheckedChange={setBlur} />} />}
      <Row
        title={gen.label}
        tip={gen.tip}
        status={s.blurFaces && on ? <Status>{LIBRARY_WORDS.proxiesFromBlurred}</Status> : undefined}
        control={<Switch aria-label={gen.label} checked={on} onCheckedChange={setProxy} />}
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
 * Hosted media: the Upload to server master and Final exports, Proxies (while they are made) and Originals under it in any mix, the same
 * component as setup's last step (./settings/Hosted.tsx). On This Mac, with the server on this computer, there is no
 * server to upload to: the row says so and nothing else is shown. Read from the server's kind: a Server opened in the
 * Mac app by its admin also watches folders, and hiding its switches there left hosted proxies locked on.
 */
function Hosted({ library, save }: { library: LibrarySummary; save: (s: Partial<Settings>) => Promise<unknown> }) {
  const noServer = useAuth((a) => a.kind) === "mac";
  return (
    <Card>
      {noServer ? (
        <Row title={LIBRARY_WORDS.uploadToServer} status={<Status>{LIBRARY_WORDS.noServer}</Status>} />
      ) : (
        <HostedSwitches
          value={hostedOf(library.settings)}
          onChange={(m) => void save(hostedSettings(m, library.settings.finalsUpload))}
          // its switch is in Proxy workflow: here it names the rows (Blurred in place of Originals)
          blurFaces={!!library.settings.blurFaces}
          proxies={makesProxies(library.settings)}
        />
      )}
    </Card>
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
