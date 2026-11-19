import { LIBRARY_WORDS } from "@contracts/library";
import { FOLDER_LABELS, foundFolder } from "@contracts/storage";
import { Button } from "@/components/ui/button";
import { Row } from "@/components/settings/ui";
import { pickFolderOnMac, type PickedFolder } from "@/lib/thisMac";

/**
 * The Library folder (11-19, Andri: "I'm gonna click on home, new folder, create creator toolset and nothing else"): one
 * folder that holds Source media, Project files and Final exports. Its subfolders are found by their usual names in any
 * case (FOLDER_ALIASES: Moo's FOOTAGE, PROJECTS, EXPORTS) and used as they are; only the missing ones are made, on Done.
 * The same row in setup's Folders step and on the owner page's Folders.
 */
export const LIBRARY_USES = ["footage", "projects", "library"] as const;
export type LibraryUse = (typeof LIBRARY_USES)[number];

/** Where each use goes inside `base`: a found subfolder (its own name) or the usual name to make. `names`: what is in it. */
export function layoutIn(base: string, names: readonly string[] | undefined): { use: LibraryUse; path: string; found: boolean }[] {
  const root = base.replace(/\/+$/, "");
  return LIBRARY_USES.map((use) => {
    const hit = foundFolder(names, use);
    return { use, path: `${root}/${hit ?? FOLDER_LABELS[use]}`, found: !!hit };
  });
}

/** The names to make inside `base`: the uses not found there (all of them when nothing is known of it). */
export const missingIn = (names: readonly string[] | undefined): string[] => layoutIn("", names).filter((l) => !l.found).map((l) => FOLDER_LABELS[l.use]);

const wrapAtSlashes = (p: string) => p.replace(/\//g, "/​");

/**
 * The row: the folder (or Custom), Change… (the Mac app's folder window), the three uses under it with Found or Will be
 * created, and Choose each folder for paths of one's own. `lines` off: the uses are shown by the rows below it instead.
 */
export function LibraryFolderRow({
  path,
  names,
  custom,
  lines = true,
  onPick,
  onCustom,
}: {
  path: string;
  names: readonly string[] | undefined;
  custom: boolean;
  lines?: boolean;
  onPick: (picked: PickedFolder) => void;
  onCustom?: () => void;
}) {
  const layout = layoutIn(path, names);
  return (
    <Row
      title={LIBRARY_WORDS.libraryFolder.label}
      tip={LIBRARY_WORDS.libraryFolder.tip}
      status={custom ? LIBRARY_WORDS.customFolders : <span title={path}>{wrapAtSlashes(path)}</span>}
      control={
        <Button size="sm" variant="outline" onClick={() => void pickFolderOnMac().then((p) => p && onPick(p))}>
          {LIBRARY_WORDS.changeFolder}
        </Button>
      }
    >
      {!custom && lines && (
        <ul aria-label="Inside the Library folder" className="space-y-1 text-xs text-muted-foreground">
          {layout.map((l) => (
            <li key={l.use} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium text-foreground/70">{FOLDER_LABELS[l.use]}</span>
              <span title={l.path} className="min-w-0">{wrapAtSlashes(l.path)}</span>
              <span>· {l.found ? LIBRARY_WORDS.folderFound : LIBRARY_WORDS.folderWillBeMade}</span>
            </li>
          ))}
        </ul>
      )}
      {!custom && onCustom && (
        <button type="button" className="mt-1 text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={onCustom}>
          {LIBRARY_WORDS.chooseEachFolder}
        </button>
      )}
    </Row>
  );
}
