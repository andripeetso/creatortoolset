import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Folder, Settings2 } from "lucide-react";
import { NEEDS, type Collection, type ImportMode, type LibraryEstimate, type LibrarySettings as Settings, type LibrarySpace, type LibraryStorage, type LibraryStep, type LibraryStepRoute, type LibrarySummary, type WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Card, ListRow, Row, Section, SettingsSelect, StatusDot } from "@/components/settings/ui";
import type { Organize } from "@contracts/library";
import { CopyTo, folderName } from "@/components/LibraryProcessing";
import { ORGANIZE } from "./Organize";
import { confirmDialog } from "@/lib/dialogs";
import { clearLibrarySpace, getEstimate, getLibrarySpace, redoMany, updateLibrary } from "@/lib/library";
import { redoKinds } from "./Selection";
import { LibraryStorageSettings, storeName, thisComputer } from "../LibraryStorage";
import { chooseFolderOnMac, macImports, thisMacBridge } from "@/lib/thisMac";
import { UploadSelect } from "./UploadSelect";
import { addFrom, copyAvailable, copyRoot, IMPORT_MODES, lookForNew, NEEDS_MAC } from "./Import";
import { LibraryWatchFolders } from "../LibraryWatchFolders";

/**
 * The Media Library's settings (the owner's: the places and where the files are kept are theirs only), behind one
 * button beside its search and as Settings → Media Library (the same body, LibrarySettingsBody): how files are added
 * and the places they came from (./Import.tsx) with Look for new files, the footage folders on the server's own
 * computer, what uploads to the server, how the library is sorted (./Organize.tsx), storage with the space the
 * library's own made files take, the two AI switches, each saying where it runs, and Redo for every clip. The button
 * carries an amber dot while a folder or clip is not found.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Where a step runs, in the words of the progress line (LibraryProcessing stepLine); "off" and "none" say nothing here. */
const WHERE: Partial<Record<LibraryStepRoute, string>> = {
  provider: "your connected AI",
  api: "your Anthropic key",
  budget: "your team's AI budget",
  device: "this computer",
  server: "this server",
  openai: "your OpenAI key",
};

/** What each switch gives the person, before where it runs. */
const WHAT: Record<"describe" | "look" | "embed", string> = {
  describe: "So search finds what happens on screen, not only what is said",
  look: "A line for each shot of a longer video, so a search opens it at the moment",
  embed: "A search for \"beach\" also finds \"sand and waves\"",
};

export function LibrarySettings({
  library,
  watch,
  folders,
  onChange,
  onError,
}: {
  library: LibrarySummary;
  watch: WatchStatus;
  /** the library's manual folders, for a footage folder's "into" */
  folders: Collection[];
  onChange: (l: LibrarySummary) => void;
  onError: (e: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const attention = watch.missing > 0 || watch.folders.some((f) => !f.found);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="relative"
        aria-label={attention ? "Library settings: a footage folder or clip is not found" : "Library settings"}
        title="Library settings"
        onClick={() => setOpen(true)}
      >
        <Settings2 className="h-4 w-4" />
        <span className="hidden sm:inline">Settings</span>
        {attention && <span aria-hidden className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-background" />}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full overflow-y-scroll p-0 sm:max-w-lg">
          {/* its end scrolls clear of the assistant's button while that is in a bottom corner (it stands over the sheet) */}
          <div className="flex flex-col gap-6 p-4 pt-12 sm:p-6 sm:pt-12 [html:has(button[data-assistant-dock][data-corner^=b])_&]:pb-24">
            <SheetTitle className="text-base">Library settings</SheetTitle>
            <LibrarySettingsBody library={library} watch={watch} folders={folders} onChange={onChange} onError={onError} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** The settings themselves, in the sheet and in Settings → Media Library. */
export function LibrarySettingsBody({ library, watch, folders, onChange, onError }: { library: LibrarySummary; watch: WatchStatus; folders: Collection[]; onChange: (l: LibrarySummary) => void; onError: (e: string) => void }) {
  return (
    <>
      <AddingFiles library={library} watch={watch} onChange={onChange} onError={onError} />
      {watch.allowed && <LibraryWatchFolders libraryId={library.id} folders={folders} onOrganized={onChange} />}
      {/* on the server's own computer the same choice is the cloud copy, under Storage */}
      {!watch.allowed && (
        <Section title="Upload">
          <Card>
            <UploadSelect library={library} onChange={onChange} onError={onError} />
          </Card>
        </Section>
      )}
      <OrganizeRow library={library} onChange={onChange} onError={onError} />
      <LibraryStorageSettings libraryId={library.id} onThisComputer={watch.allowed} onSaved={(storage) => onChange({ ...library, storage })}>
        {(saved) => <SpaceRows library={library} saved={saved} onThisComputer={watch.allowed} onChange={onChange} onError={onError} />}
      </LibraryStorageSettings>
      <AiSwitches library={library} onChange={onChange} onError={onError} />
      <RedoAll library={library} onError={onError} />
    </>
  );
}

const MODE_WORDS: Record<ImportMode, string> = { "in-place": "Used where they are", copy: "Copied into the library" };

/**
 * How files are added (asked on the first add, ./Import.tsx), where copies go, the places files came from (each with
 * how it was taken, and Remove: the next add from there asks again), and Look for new files: from the Mac app with the
 * server elsewhere each place used where it is is read again on this Mac; on the server's own computer its footage
 * folders are looked at now. Not shown in a browser with the server elsewhere, where files upload.
 */
function AddingFiles({ library, watch, onChange, onError }: { library: LibrarySummary; watch: WatchStatus; onChange: (l: LibrarySummary) => void; onError: (e: string) => void }) {
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
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Couldn't look (${r.status})`);
        setLine("Looking now: new files show up as they are found");
      } else {
        const n = await lookForNew(library, setLine);
        setLine(n ? `${n.toLocaleString()} new ${n === 1 ? "file" : "files"} added` : "No new files");
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
    <Section title="Adding files">
      <Card>
        <Row
          id="library-adding"
          title="How files come in"
          description={copyOk ? IMPORT_MODES.find((o) => o.value === mode)?.detail : `${IMPORT_MODES[0]!.detail}. Copying them: ${NEEDS_MAC.toLowerCase()}`}
          control={
            <SettingsSelect
              label="How files come in"
              value={mode}
              options={copyOk ? IMPORT_MODES : IMPORT_MODES.filter((o) => o.value === "in-place")}
              onValueChange={(v) => void save({ importMode: v as ImportMode })}
            />
          }
        />
        {mode === "copy" && copyOk && (
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
            subtitle={<span title={p.path}>{MODE_WORDS[p.mode]} · {p.path}</span>}
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
            title="New files in these places"
            description={line}
            control={
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void look()}>
                Look for new files
              </Button>
            }
          />
        )}
      </Card>
    </Section>
  );
}

/** The two AI switches (api/library/db.ts SETTING_DEFAULTS): each says where it runs for this account, read from the server's own routes (the estimate). */
function AiSwitches({ library, onChange, onError }: { library: LibrarySummary; onChange: (l: LibrarySummary) => void; onError: (e: string) => void }) {
  const [routes, setRoutes] = useState<LibraryEstimate["steps"] | null>(null);
  const { describe, look, embed } = library.settings;
  useEffect(() => {
    let live = true;
    getEstimate(library.id, { clips: 1, bytes: 1 }).then(
      (e) => live && setRoutes(e.steps),
      () => live && setRoutes([]),
    );
    return () => void (live = false);
  }, [library.id, describe, look, embed]);

  const flip = (key: "describe" | "look" | "embed", on: boolean) =>
    updateLibrary(library.id, { settings: { [key]: on } })
      .then(onChange)
      .catch((e) => onError(message(e)));
  const where = (step: LibraryStep) => {
    const s = routes?.find((r) => r.step === step);
    if (!s || s.route === "off") return null;
    // what needs the person, in a few words, with the page that gives it
    if (s.route === "none")
      return (
        <span className="flex items-baseline gap-1.5">
          <StatusDot tone="attention" />
          <Link to={NEEDS[step].href} className="underline-offset-4 hover:underline">
            Needs {NEEDS[step].needs}
          </Link>
        </span>
      );
    return WHERE[s.route] ? `Uses ${WHERE[s.route]}` : null;
  };
  const row = (key: "describe" | "look" | "embed", step: LibraryStep, title: string) => (
    <Row
      title={title}
      // where search by meaning runs: the "meaning" worker's key-free route answers "device" here ("Uses this computer")
      description={
        <span className="flex flex-col gap-0.5">
          <span>{WHAT[key]}</span>
          {library.settings[key] && where(step)}
        </span>
      }
      control={<Switch aria-label={title} checked={library.settings[key]} onCheckedChange={(on) => void flip(key, on)} />}
    />
  );
  return (
    <Section id="library-ai" title="AI">
      <Card>
        {row("describe", "describe", "Write down what is in each video")}
        {row("look", "look", "Shot descriptions")}
        {row("embed", "embed", "Search by meaning, not exact words")}
      </Card>
    </Section>
  );
}

/** How the library sorts files into folders (the first upload's question, ./Organize.tsx); a library never asked shows No folders. */
function OrganizeRow({ library, onChange, onError }: { library: LibrarySummary; onChange: (l: LibrarySummary) => void; onError: (e: string) => void }) {
  const value = library.settings.organize ?? "own";
  return (
    <Section title="Sorting">
      <Card>
        <Row
          id="library-sorting"
          title="Folders"
          description={ORGANIZE.find((o) => o.value === value)?.detail}
          control={
            <SettingsSelect
              label="Folders"
              value={value}
              options={ORGANIZE}
              onValueChange={(v) =>
                void updateLibrary(library.id, { settings: { organize: v as Organize } })
                  .then(onChange)
                  .catch((e) => onError(message(e)))
              }
            />
          }
        />
      </Card>
    </Section>
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
 * Where the files are, and what the library makes (api/library/space.ts): the videos, the proxies switch and what they take with Clear, the thumbnails, and the downloaded speech
 * and search models with Clear. The person's own files are never cleared. Proxies kept in the cloud (one for every
 * video) have no switch and no Clear: both would do nothing there.
 */
function SpaceRows({ library, saved, onThisComputer, onChange, onError }: { library: LibrarySummary; saved: LibraryStorage | null; onThisComputer: boolean; onChange: (l: LibrarySummary) => void; onError: (e: string) => void }) {
  const [space, setSpace] = useState<LibrarySpace | null>(null);
  const cloud = saved?.proxies ?? null;
  const read = () => getLibrarySpace(library.id).then(setSpace, (e: unknown) => onError(message(e)));
  useEffect(() => void read(), [library.id, !!cloud]); // eslint-disable-line react-hooks/exhaustive-deps
  const clear = async (what: "proxies" | "models", bytes: number) => {
    const ok = await confirmDialog(
      what === "proxies"
        ? { title: "Clear the proxies?", body: `They take ${size(bytes)}. Each is generated again when a clip that needs one is opened. Your own footage is not touched.`, ok: "Clear" }
        : { title: "Clear the speech and search models?", body: `They take ${size(bytes)} and download again the next time they are needed. Your own footage is not touched.`, ok: "Clear" },
    );
    if (!ok) return;
    await clearLibrarySpace(library.id, what).catch((e: unknown) => onError(message(e)));
    await read();
  };
  const flip = (on: boolean) =>
    updateLibrary(library.id, { settings: { proxy: on } })
      .then(onChange)
      .catch((e) => onError(message(e)));
  const onMac = thisMacBridge() && !onThisComputer ? { upload: library.settings.upload !== "none" } : null;
  return (
    <>
      {space && <Row title="Video files" description={videoPlace(space.videos, { saved, onThisComputer, onMac })} />}
      {!cloud && (
        <Row
          id="library-proxies"
          title="Generate proxies"
          description="Smaller copies of 4K, 10-bit and camera files, for smooth playback"
          control={<Switch aria-label="Generate proxies" checked={library.settings.proxy} onCheckedChange={(on) => void flip(on)} />}
        />
      )}
      {space && (
        <Row
          title="Proxies"
          description={cloud ? `In ${storeName(cloud)}, ${size(saved?.storedBytes ?? 0)}` : space.proxies.files ? size(space.proxies.bytes) : "None yet"}
          control={
            space.proxies.files > 0 &&
            !cloud && (
              <Button size="sm" variant="outline" onClick={() => void clear("proxies", space.proxies.bytes)}>
                Clear
              </Button>
            )
          }
        />
      )}
      {space && <Row title="Thumbnails" description={space.pictures.files ? size(space.pictures.bytes) : "None yet"} />}
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
    </>
  );
}

/**
 * Redo for every clip: descriptions, transcripts or search data made again for the whole library, on the person's own
 * AI. A press asks once more in its own row, saying how many clips it is, before anything runs.
 */
function RedoAll({ library, onError }: { library: LibrarySummary; onError: (e: string) => void }) {
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
    <Section title="Redo for every clip">
      <Card>
        {redoKinds(library.settings).map((r) => (
          <Row
            key={r.kind}
            title={r.label}
            description={asking?.kind === r.kind ? (asking.clips === 1 ? "For 1 clip" : `For ${asking.clips} clips`) : done === r.kind ? "On its way" : null}
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
