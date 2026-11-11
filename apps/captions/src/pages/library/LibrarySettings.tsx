import { useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import type { Collection, LibraryEstimate, LibraryStep, LibraryStepRoute, LibrarySummary, WatchStatus } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Card, Row, Section, StatusDot } from "@/components/settings/ui";
import { getEstimate, updateLibrary } from "@/lib/library";
import { LibraryStorageSettings } from "../LibraryStorage";
import { LibraryWatchFolders } from "../LibraryWatchFolders";

/**
 * The Media Library's settings, behind one button beside its search (the owner's: the footage folders and where the
 * files are kept are theirs only): the footage folders (on the person's own computer), storage, and the two AI
 * switches, each saying where it runs. The button carries an amber dot while a folder or clip is not found.
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
          <div className="flex flex-col gap-6 p-4 pt-12 sm:p-6 sm:pt-12">
            <SheetTitle className="text-base">Library settings</SheetTitle>
            {watch.allowed && <LibraryWatchFolders libraryId={library.id} folders={folders} />}
            <LibraryStorageSettings libraryId={library.id} onThisComputer={watch.allowed} onSaved={(storage) => onChange({ ...library, storage })} />
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
    // what needs the person, said whole (a Status line would cut it off)
    if (s.route === "none")
      return s.missing ? (
        <span className="flex items-baseline gap-1.5">
          <StatusDot tone="attention" />
          {s.missing}
        </span>
      ) : null;
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
