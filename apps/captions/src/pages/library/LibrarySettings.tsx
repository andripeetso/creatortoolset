import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Folder } from "lucide-react";
import { LOOK_LEVELS, NEEDS, WATCH_MODELS, watchModelOf, type Collection, type ImportMode, type LibraryEstimate, type LibrarySettings as Settings, type LibrarySpace, type LibraryStorage, type LibraryStep, type LibraryStepRoute, type LibrarySummary, type WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Card, InUse, ListRow, Row, Section, SettingsSelect, Status, TextField } from "@/components/settings/ui";
import type { Organize } from "@contracts/library";
import { aboutTime, aboutUsd, CopyTo, folderName } from "@/components/LibraryProcessing";
import { FOLDER_NAMES, ORGANIZE_NAME } from "./Organize";
import { confirmDialog } from "@/lib/dialogs";
import { clearLibrarySpace, getEstimate, getLibrarySpace, redoMany, updateLibrary } from "@/lib/library";
import { redoKinds } from "./Selection";
import { LibraryStorageSettings, storeName, thisComputer } from "../LibraryStorage";
import { chooseFolderOnMac, macImports, thisMacBridge } from "@/lib/thisMac";
import { UploadSelect } from "./UploadSelect";
import { addFrom, copyAvailable, copyRoot, lookedLine, lookForNew } from "./Import";
import { LibraryWatchFolders } from "../LibraryWatchFolders";

/**
 * The Media Library's settings (the owner's: the places and where the files are kept are theirs only), behind one
 * button beside its search and as Settings → Media Library (the same body, LibrarySettingsBody). One section per
 * question, in the order a file meets them: Adding files (how files are imported and the places they came from,
 * ./Import.tsx, with Look for new files, and how the library is sorted, ./Organize.tsx); the footage folders on the
 * server's own computer (the library's own sheet only: in Settings they are the Folders page's); Uploads (what of the
 * footage and the finals goes to the server, and where); Storage (where the video files are, proxies, and the space the
 * library's own made files take); Descriptions (what is written down about each video, with Shot detail and the
 * Timeline model under it); Search (how a search matches); All clips (redo). The button carries an amber dot while a
 * folder or clip is not found.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Where a step runs, in the words of the progress line (LibraryProcessing stepLine); "off" and "none" say nothing here. */
const WHERE: Partial<Record<LibraryStepRoute, string>> = {
  provider: "the AI provider",
  api: "the Anthropic key",
  budget: "the team budget",
  device: "this computer",
  server: "this server",
  openai: "the OpenAI key",
};

/** What each switch adds, before where it runs. */
const WHAT: Record<"describe" | "look" | "timeline" | "embed" | "pictures", string> = {
  describe: "A few sentences on what is on screen in each video, used by search.",
  look: "A line for each shot of a longer video, used by search.",
  timeline: "What happens when in each longer video, from its picture and sound.",
  embed: "A search matches clips by meaning as well as by its exact words.",
  pictures: "A search matches what is in the picture as well as what is said and written.",
};

/** The two ways a file is imported, in the words of these settings (the add dialog asks the same in its own, ./Import.tsx). */
const IMPORT: { value: ImportMode; label: string; detail: string; was: string }[] = [
  { value: "in-place", label: "Keep in place", detail: "Files stay in their own folders, and the library reads them from there.", was: "Kept in place" },
  { value: "copy", label: "Copy into the library", detail: "Files are copied into the library's Footage, Audio and Pictures folders.", was: "Copied into the library" },
];

/**
 * The library's folders, in the words of these settings: the three choices by the names the first add offers them under
 * (./Organize.tsx), and what the chosen one means. Standard makes the folders and files nothing itself (A-roll and
 * B-roll fill from the roll the app sorts; api/library/organize.ts), so its line names the folders and no more.
 */
const SORTING: { value: Organize; label: string; detail: string }[] = [
  { value: "default", label: ORGANIZE_NAME.default, detail: `The library has the folders ${FOLDER_NAMES}.` },
  { value: "ai", label: ORGANIZE_NAME.ai, detail: "Folders are named after the footage in them, and each new file goes into one." },
  { value: "own", label: ORGANIZE_NAME.own, detail: "Files stay in one list, with no folders." },
];

/** A footage folder or a clip the library cannot find: the page's More button carries a dot. */
export const needsAttention = (watch: WatchStatus) => watch.missing > 0 || watch.folders.some((f) => !f.found);

interface BodyProps {
  library: LibrarySummary;
  watch: WatchStatus;
  /** the library's manual folders, for a footage folder's "into" */
  folders: Collection[];
  onChange: (l: LibrarySummary) => void;
  onError: (e: string) => void;
}

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
 * The settings themselves, in the sheet and in Settings → Media Library. `inSettings`: what Settings → Folders owns is
 * left out (the footage folders, and the folder a copy goes into).
 */
export function LibrarySettingsBody({ library, watch, folders, onChange, onError, inSettings }: BodyProps & { inSettings?: boolean }) {
  return (
    <>
      <Section title="Adding files">
        <Card>
          <ImportRows library={library} watch={watch} onChange={onChange} onError={onError} inSettings={inSettings} />
          <SortingRow library={library} onChange={onChange} onError={onError} />
        </Card>
      </Section>
      {watch.allowed && !inSettings && <LibraryWatchFolders libraryId={library.id} folders={folders} onOrganized={onChange} />}
      <Storage library={library} onThisComputer={watch.allowed} onChange={onChange} onError={onError} />
      <AiSwitches library={library} onChange={onChange} onError={onError} />
      <RedoAll library={library} onError={onError} />
    </>
  );
}

/**
 * How files are imported (asked on the first add, ./Import.tsx), where copies go, the places files came from (each with
 * how it was taken, and Remove: the next add from there asks again), and Look for new files: from the Mac app with the
 * server elsewhere each place kept in place is read again on this Mac; on the server's own computer its footage
 * folders are looked at now. Not shown in a browser with the server elsewhere, where files upload.
 */
function ImportRows({ library, watch, onChange, onError, inSettings }: Pick<BodyProps, "library" | "watch" | "onChange" | "onError"> & { inSettings?: boolean }) {
  const [line, setLine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const from = addFrom(watch.allowed);
  if (from === "browser") return null;
  const mode = library.settings.importMode ?? "in-place";
  // a folder on the server's own computer is copied by the server; anything else by the Mac app
  const copyOk = copyAvailable(from, true);
  const save = (settings: Partial<Settings>) =>
    updateLibrary(library.id, { settings })
      .then(onChange)
      .catch((e) => onError(message(e)));
  // the footage folders on the server's own computer are listed in their own section
  const places = (library.settings.places ?? []).filter((p) => !watch.folders.some((f) => f.path === p.path));
  const canLook = from === "here" ? watch.folders.length > 0 : macImports() && places.some((p) => p.mode === "in-place");
  const look = async () => {
    setBusy(true);
    try {
      if (from === "here") {
        // the footage folders saved again as they are: the server looks at them at once
        const folders = watch.folders.map(({ path, mode, collectionId, copyTo }) => ({ path, mode, collectionId, copyTo }));
        const r = await fetch(`/api/library/${library.id}/watch`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ folders }) });
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Could not look for new files (${r.status})`);
        setLine("Looking for new files…");
      } else {
        const { added, reconnected } = await lookForNew(library, setLine);
        setLine(lookedLine(added, reconnected));
      }
    } catch (e) {
      setLine(null);
      onError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const change = async () => {
    const picked = await chooseFolderOnMac();
    if (picked) await save({ copyTo: picked });
  };
  return (
    <>
      <Row
        id="library-adding"
        title="Import"
        description={IMPORT.find((o) => o.value === (copyOk ? mode : "in-place"))?.detail}
        status={!copyOk && <Status>Copy needs the latest Mac app</Status>}
        control={<SettingsSelect label="Import" value={mode} options={copyOk ? IMPORT : IMPORT.filter((o) => o.value === mode || o.value === "in-place")} onValueChange={(v) => void save({ importMode: v as ImportMode })} />}
      />
      {mode === "copy" && copyOk && !inSettings && (
        <Row
          title="Library folder"
          description={<CopyTo path={from === "here" && watch.copyTo ? watch.copyTo : copyRoot(library)} />}
          control={
            from === "here" ? (
              <Button size="sm" variant="outline" asChild>
                <Link to="/settings/folders">Change</Link>
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => void change()}>
                Change
              </Button>
            )
          }
        />
      )}
      {places.map((p) => (
        <ListRow
          key={p.path}
          icon={<Folder />}
          title={folderName(p.path)}
          subtitle={<span title={p.path}>{IMPORT.find((o) => o.value === p.mode)?.was} · {p.path}</span>}
          actions={
            <Button size="sm" variant="ghost" onClick={() => void save({ places: (library.settings.places ?? []).filter((x) => x.path !== p.path) })}>
              Remove
            </Button>
          }
        />
      ))}
      {canLook && (
        <Row
          id="library-look"
          title="New files"
          status={line && <Status>{line}</Status>}
          control={
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void look()}>
              Look for new files
            </Button>
          }
        />
      )}
    </>
  );
}

/** What search reads, a switch each (api/library/db.ts SETTING_DEFAULTS): each says where it runs for this account, read from the server's own routes (the estimate). */
function AiSwitches({ library, onChange, onError }: Pick<BodyProps, "library" | "onChange" | "onError">) {
  const [est, setEst] = useState<LibraryEstimate | null>(null);
  const routes = est?.steps ?? null;
  const { describe, look, timeline, embed, lookLevel, lookBudget } = library.settings;
  useEffect(() => {
    let live = true;
    getEstimate(library.id, { clips: 1, bytes: 1 }).then(
      (e) => live && setEst(e),
      () => live && setEst({ clips: 0, minutes: 0, steps: [], seconds: 0 }),
    );
    return () => void (live = false);
  }, [library.id, describe, look, timeline, embed, lookLevel, lookBudget, library.settings.timelineModel]);

  const flip = (key: "describe" | "look" | "timeline" | "embed" | "pictures", on: boolean) =>
    updateLibrary(library.id, { settings: { [key]: on } })
      .then(onChange)
      .catch((e) => onError(message(e)));
  const where = (step: LibraryStep) => {
    const s = routes?.find((r) => r.step === step);
    if (!s || s.route === "off") return null;
    // what is missing, in a few words, with the page that has it
    if (s.route === "none")
      return (
        <Status tone="attention">
          <Link to={NEEDS[step].href} className="underline-offset-4 hover:underline">
            Needs {NEEDS[step].needs}
          </Link>
        </Status>
      );
    return WHERE[s.route] ? <Status>Uses {WHERE[s.route]}</Status> : null;
  };
  const row = (key: "describe" | "look" | "embed", step: LibraryStep, title: string) => (
    <Row
      title={title}
      description={WHAT[key]}
      // where search by meaning runs: the "meaning" worker's key-free route says "device" here ("Uses this computer")
      status={library.settings[key] && where(step)}
      control={<Switch aria-label={title} checked={library.settings[key]} onCheckedChange={(on) => void flip(key, on)} />}
    />
  );
  return (
    <>
      <Section id="library-ai" title="Descriptions">
        <Card>
          {row("describe", "describe", "Clip descriptions")}
          {row("look", "look", "Shot descriptions")}
          {look && (
            <Row
              title="Timelines"
              description={WHAT.timeline}
              status={
                timeline &&
                est &&
                (watchModelOf(library.settings.timelineModel) === "antigravity" ? (
                  est.timelineAntigravity ? (
                    <Status>Uses Antigravity</Status>
                  ) : (
                    <Status tone="attention">
                      <Link to="/settings/providers" className="underline-offset-4 hover:underline">
                        Needs Antigravity
                      </Link>
                    </Status>
                  )
                ) : est.timelineKey ? (
                  est.timelineStopped === "free" ? (
                    <Status tone="attention">The Gemini key is on Google's free tier, about 20 calls a day; billing in Google AI Studio lifts the limit</Status>
                  ) : est.timelineStopped === "credit" ? (
                    <Status tone="attention">The Gemini credit ran out; timelines wait until it is topped up in Google AI Studio</Status>
                  ) : (
                    <Status>Uses the Gemini API key</Status>
                  )
                ) : (
                  <Status tone="attention">
                    <Link to="/settings/keys" className="underline-offset-4 hover:underline">
                      Needs a Gemini API key
                    </Link>
                  </Status>
                ))
              }
              control={<Switch aria-label="Timelines" checked={timeline} onCheckedChange={(on) => void flip("timeline", on)} />}
            />
          )}
        </Card>
      </Section>
      {look && <ShotDetail library={library} estimate={est} onChange={onChange} onError={onError} />}
      {look && timeline && (
        <Section id="library-timeline-model" title="Timeline model">
          <Card>
            {/* what watches, each model with what an hour of footage costs at the library's level (estimate.ts timelineModels) */}
            {WATCH_MODELS.map((m) => {
              const usd = est?.timelineModels?.find((x) => x.model === m.value)?.usd;
              return (
                <ListRow
                  key={m.value}
                  title={m.label}
                  subtitle={usd === undefined ? m.note : `${m.note}, ${aboutUsd(usd)} for each hour of footage`}
                  actions={
                    m.value === watchModelOf(library.settings.timelineModel) ? (
                      <InUse>In use</InUse>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void updateLibrary(library.id, { settings: { timelineModel: m.value } })
                            .then(onChange)
                            .catch((e: unknown) => onError(message(e)))
                        }
                      >
                        Use
                      </Button>
                    )
                  }
                />
              );
            })}
          </Card>
        </Section>
      )}
      <Section id="library-search" title="Search">
        <Card>
          {row("embed", "embed", "Search by meaning")}
          {/* made here or on the person's own computers (api/library/pictures.ts): nothing to add; absent on an older server */}
          {library.settings.pictures !== undefined && (
            <Row
              title="Search by picture"
              description={WHAT.pictures}
              control={<Switch aria-label="Search by picture" checked={library.settings.pictures} onCheckedChange={(on) => void flip("pictures", on)} />}
            />
          )}
        </Card>
      </Section>
    </>
  );
}

/** "$2.64 and about 12 min for each hour of footage": a level's cost and time for an hour of footage (estimate.ts lookLevels). */
const perHour = (seconds: number, usd: number) => `${aboutUsd(usd).replace(/^about /, "")} and ${aboutTime(seconds)} for each hour of footage`;

/**
 * How densely shots are described (contracts LOOK_LEVELS), each level with the time and cost of an hour of footage on
 * this account's route (estimate.ts lookLevels), and the monthly budget with this month's spend. A new level describes
 * the clips from then on; All clips → Shot descriptions describes the others again.
 */
function ShotDetail({ library, estimate, onChange, onError }: Pick<BodyProps, "library" | "onChange" | "onError"> & { estimate: LibraryEstimate | null }) {
  const { lookLevel, lookBudget } = library.settings;
  const save = (settings: Partial<Settings>) => updateLibrary(library.id, { settings }).then(onChange);
  const budget = async (text: string) => {
    const t = text.trim().replace(/^\$/, "");
    const usd = t === "" ? null : Number(t);
    if (usd !== null && !(Number.isFinite(usd) && usd >= 0)) throw new Error("Needs an amount in dollars");
    await save({ lookBudget: usd });
  };
  const spent = estimate?.lookSpent;
  const reached = spent !== undefined && lookBudget !== null && spent >= lookBudget;
  return (
    <Section id="library-shot-detail" title="Shot detail">
      <Card>
        {LOOK_LEVELS.map((l) => {
          const e = estimate?.lookLevels?.find((x) => x.level === l.value);
          return (
            <ListRow
              key={l.value}
              title={l.label}
              subtitle={e ? perHour(e.seconds, e.usd) : `A line every ${l.piece} to ${l.long} seconds of a long take`}
              actions={
                l.value === lookLevel ? (
                  <InUse>In use</InUse>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void save({ lookLevel: l.value }).catch((err: unknown) => onError(message(err)))}>
                    Use
                  </Button>
                )
              }
            />
          );
        })}
        <Row
          id="library-shot-budget"
          title="Monthly budget"
          description="Shot descriptions wait for next month once they cost this much, in dollars."
          status={spent !== undefined ? <Status tone={reached ? "attention" : undefined}>{reached ? "Reached: " : ""}${spent.toFixed(2)} this month</Status> : null}
          control={<TextField label="Monthly budget" value={lookBudget === null ? "" : String(lookBudget)} placeholder="No limit" onCommit={budget} className="sm:w-28" />}
        />
      </Card>
    </Section>
  );
}

/** The library's folders (the first add's question, ./Organize.tsx); a library never asked shows None. */
function SortingRow({ library, onChange, onError }: Pick<BodyProps, "library" | "onChange" | "onError">) {
  const value = library.settings.organize ?? "own";
  return (
    <Row
      id="library-sorting"
      title="Folders"
      description={SORTING.find((o) => o.value === value)?.detail}
      control={
        <SettingsSelect
          label="Folders"
          value={value}
          options={SORTING}
          onValueChange={(v) =>
            void updateLibrary(library.id, { settings: { organize: v as Organize } })
              .then(onChange)
              .catch((e) => onError(message(e)))
          }
        />
      }
    />
  );
}

const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : "under 1 MB");
const files = (n: number) => `${n.toLocaleString()} ${n === 1 ? "file" : "files"}`;

/**
 * Where the library's videos are, in a few words (api/library/space.ts videos): on a Mac and not uploaded, read where
 * they are on this computer, or stored by the server (its disk or a bucket, with the size). An empty library says
 * where new files go. `onMac`: the Mac app with the server elsewhere, and its upload switch.
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

/**
 * The Storage section (../LibraryStorage.tsx). Upload to the server: with the server elsewhere the library's own
 * setting, on its own computer the cloud copy. Where the video files are is said by that row (videoFacts); a row of
 * its own says it only where that row is not drawn.
 */
function Storage({ library, onThisComputer, onChange, onError }: Pick<BodyProps, "library" | "onChange" | "onError"> & { onThisComputer: boolean }) {
  const [space, setSpace] = useState<LibrarySpace | null>(null);
  const read = () => getLibrarySpace(library.id).then(setSpace, (e: unknown) => onError(message(e)));
  const onMac = thisMacBridge() && !onThisComputer ? { upload: library.settings.upload !== "none" } : null;
  const place = (saved: LibraryStorage | null) => ({ saved, onThisComputer, onMac });
  return (
    <LibraryStorageSettings
      libraryId={library.id}
      onThisComputer={onThisComputer}
      onSaved={(storage) => onChange({ ...library, storage })}
      videos={(saved) => (space ? videoFacts(space.videos, place(saved)) : undefined)}
      upload={(facts) => <UploadSelect library={library} onChange={onChange} onError={onError} facts={facts} />}
    >
      {(saved, uploadRow) => (
        <SpaceRows library={library} saved={saved} space={space} read={read} videos={space && saved && !uploadRow ? videoPlace(space.videos, place(saved)) : null} onChange={onChange} onError={onError} />
      )}
    </LibraryStorageSettings>
  );
}

/**
 * What the library makes (api/library/space.ts): the proxies switch, the proxy files with what they take and Clear,
 * and the downloaded speech and search models with Clear. The person's own files are never cleared. Proxies kept in the
 * cloud (one for every video) have no switch and no Clear: both would do nothing there. `videos`: where the video files
 * are, as a row of its own (no Upload row says it).
 */
function SpaceRows({ library, saved, space, read, videos, onChange, onError }: Pick<BodyProps, "library" | "onChange" | "onError"> & { saved: LibraryStorage | null; space: LibrarySpace | null; read: () => Promise<void>; videos: string | null }) {
  const cloud = saved?.proxies ?? null;
  useEffect(() => void read(), [library.id, !!cloud]); // eslint-disable-line react-hooks/exhaustive-deps
  const clear = async (what: "proxies" | "models", bytes: number) => {
    const ok = await confirmDialog(
      what === "proxies"
        ? { title: "Clear the proxy files?", body: `${size(bytes)} of proxy files are removed. The video files are not deleted.`, ok: "Clear" }
        : { title: "Clear the speech and search models?", body: `${size(bytes)} of models are removed.`, ok: "Clear" },
    );
    if (!ok) return;
    await clearLibrarySpace(library.id, what).catch((e: unknown) => onError(message(e)));
    await read();
  };
  const flip = (on: boolean) =>
    updateLibrary(library.id, { settings: { proxy: on } })
      .then(onChange)
      .catch((e) => onError(message(e)));
  const proxyFiles = !!space && (cloud || space.proxies.files > 0);
  const models = !!space?.models && space.models.bytes > 0;
  if (!videos && cloud && !proxyFiles && !models) return null;
  return (
    <Section title="Storage">
      <Card>
        {videos && <Row title="Video files" description={videos} />}
        {!cloud && (
          <Row
            id="library-proxies"
            title="Proxies"
            description="A smaller copy of each 4K, 10-bit or camera file, so it plays smoothly."
            control={<Switch aria-label="Proxies" checked={library.settings.proxy} onCheckedChange={(on) => void flip(on)} />}
          />
        )}
        {space && cloud && <Row title="Proxy files" description={`In ${storeName(cloud)}, ${size(saved?.storedBytes ?? 0)}`} />}
        {space && !cloud && space.proxies.files > 0 && (
          <Row
            title="Proxy files"
            description={size(space.proxies.bytes)}
            control={
              <Button size="sm" variant="outline" onClick={() => void clear("proxies", space.proxies.bytes)}>
                Clear
              </Button>
            }
          />
        )}
        {space?.models && space.models.bytes > 0 && (
          <Row
            title="Speech and search models"
            description={size(space.models.bytes)}
            control={
              <Button size="sm" variant="outline" onClick={() => void clear("models", space.models!.bytes)}>
                Clear
              </Button>
            }
          />
        )}
      </Card>
    </Section>
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
    <Section title="All clips">
      <Card>
        {redoKinds(library.settings).map((r) => (
          <Row
            key={r.kind}
            title={r.label}
            status={asking?.kind === r.kind ? <Status>{asking.clips === 1 ? "For 1 clip" : `For ${asking.clips} clips`}</Status> : done === r.kind ? <Status>Started</Status> : null}
            control={
              asking?.kind === r.kind ? (
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>
                    Cancel
                  </Button>
                  <Button size="sm" disabled={!asking.clips} onClick={() => void run(r.kind)}>
                    Redo all
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={() => void ask(r.kind)}>
                  Redo
                </Button>
              )
            }
          />
        ))}
      </Card>
    </Section>
  );
}
