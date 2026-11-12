import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Settings2 } from "lucide-react";
import { NEEDS, type Collection, type LibraryEstimate, type LibrarySpace, type LibraryStep, type LibraryStepRoute, type LibrarySummary, type WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Card, Row, Section, StatusDot } from "@/components/settings/ui";
import { confirmDialog } from "@/lib/dialogs";
import { clearLibrarySpace, getEstimate, getLibrarySpace, updateLibrary } from "@/lib/library";
import { LibraryStorageSettings } from "../LibraryStorage";
import { LibraryWatchFolders } from "../LibraryWatchFolders";

/**
 * The Media Library's settings, behind one button beside its search (the owner's: the footage folders and where the
 * files are kept are theirs only): the footage folders (on the person's own computer), storage with the space the
 * library's own made files take, and the two AI switches, each saying where it runs. The button carries an amber dot
 * while a folder or clip is not found.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Where a step runs, in the words of the progress line (LibraryProcessing stepLine); "off" and "none" say nothing here. */
const WHERE: Partial<Record<LibraryStepRoute, string>> = {
  provider: "Runs on your connected AI",
  api: "Runs on your Anthropic key",
  budget: "Runs on your team's AI budget",
  device: "Runs on this computer",
  server: "Runs on this server",
  openai: "Runs on your OpenAI key",
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
            {watch.allowed && <LibraryWatchFolders libraryId={library.id} folders={folders} />}
            <LibraryStorageSettings libraryId={library.id} onThisComputer={watch.allowed} onSaved={(storage) => onChange({ ...library, storage })}>
              {open && <SpaceRows library={library} onChange={onChange} onError={onError} />}
            </LibraryStorageSettings>
            {open && <AiSwitches library={library} onChange={onChange} onError={onError} />}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** The two AI switches (api/library/db.ts SETTING_DEFAULTS): each says where it runs for this account, read from the server's own routes (the estimate). */
function AiSwitches({ library, onChange, onError }: { library: LibrarySummary; onChange: (l: LibrarySummary) => void; onError: (e: string) => void }) {
  const [routes, setRoutes] = useState<LibraryEstimate["steps"] | null>(null);
  const { describe, embed } = library.settings;
  useEffect(() => {
    let live = true;
    getEstimate(library.id, { clips: 1, bytes: 1 }).then(
      (e) => live && setRoutes(e.steps),
      () => live && setRoutes([]),
    );
    return () => void (live = false);
  }, [library.id, describe, embed]);

  const flip = (key: "describe" | "embed", on: boolean) =>
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
    return WHERE[s.route] ?? null;
  };
  const row = (key: "describe" | "embed", step: LibraryStep, title: string) => (
    <Row
      title={title}
      // where search by meaning runs: the "meaning" worker's key-free route answers "device" here ("Runs on this computer")
      description={library.settings[key] ? where(step) : null}
      control={<Switch aria-label={title} checked={library.settings[key]} onCheckedChange={(on) => void flip(key, on)} />}
    />
  );
  return (
    <Section title="AI">
      <Card>
        {row("describe", "describe", "AI describes new videos")}
        {row("embed", "embed", "Search by meaning")}
      </Card>
    </Section>
  );
}

const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : n > 0 ? "under 1 MB" : "nothing");

/**
 * The library's own made files (api/library/space.ts): the proxies switch, what the proxies take with Clear, the cards'
 * pictures, and the downloaded speech and search models with Clear. The person's own files are never in it.
 */
function SpaceRows({ library, onChange, onError }: { library: LibrarySummary; onChange: (l: LibrarySummary) => void; onError: (e: string) => void }) {
  const [space, setSpace] = useState<LibrarySpace | null>(null);
  const read = () => getLibrarySpace(library.id).then(setSpace, (e: unknown) => onError(message(e)));
  useEffect(() => void read(), [library.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const clear = async (what: "proxies" | "models", bytes: number) => {
    const ok = await confirmDialog(
      what === "proxies"
        ? { title: "Clear the proxies?", body: `They take ${size(bytes)}. Each is made again when a clip that needs one is opened. Your own footage is not touched.`, ok: "Clear" }
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
  return (
    <>
      <Row
        title="Make proxies"
        description="For videos this window can't play as they are"
        control={<Switch aria-label="Make proxies" checked={library.settings.proxy} onCheckedChange={(on) => void flip(on)} />}
      />
      {space && (
        <Row
          title="Proxies"
          description={size(space.proxies.bytes)}
          control={
            space.proxies.files > 0 && (
              <Button size="sm" variant="outline" onClick={() => void clear("proxies", space.proxies.bytes)}>
                Clear
              </Button>
            )
          }
        />
      )}
      {space && space.pictures.files > 0 && <Row title="Pictures" description={size(space.pictures.bytes)} />}
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
