import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { LIBRARY_WORDS } from "@contracts/library";
import { FOLDER_LABELS, foundFolder } from "@contracts/storage";
import { Button } from "@/components/ui/button";
import { Row } from "@/components/settings/ui";
import { cn } from "@/lib/utils";
import { pickFolderOnMac, type PickedFolder } from "@/lib/thisMac";

/**
 * The Library folder (11-19, Andri: "I'm gonna click on home, new folder, create creator toolset and nothing else"): one
 * folder that holds Source media, Project files and Final exports. Its subfolders are found by their usual names in any
 * case (FOLDER_ALIASES: Moo's FOOTAGE, PROJECTS, EXPORTS) and used as they are; only the missing ones are made, on Done.
 * The same box in setup's Folders step and on the owner page's Folders (11-19 sign-off B2, B3, D1).
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

const fold = "grid transition-[grid-template-rows] duration-[260ms] ease-out motion-reduce:transition-none";

const wrapAtSlashes = (p: string) => p.replace(/\//g, "/​");

/** One line of the summary: the use, the folder (its name inside the Library folder, else its full path), and a note. */
export interface SummaryLine {
  use: LibraryUse;
  folder: string;
  note?: string;
  /** a button on the line that picks this one folder by itself (the owner page: Set…, Change…, Add folder…) */
  action?: { label: string; onClick: () => void };
}

/**
 * The box: the Library folder with Change… (`top` off: none, the existing-folders case), a line saying what the folders
 * are (`head`), the three in two columns, and ⋯ that unrolls them into rows with Change… each (`children`) and folds them
 * back. The part not shown is inert, so its buttons are out of the tab order. `below`: lines that stay in both states.
 */
export function LibraryFolderBox({
  path,
  onPick,
  top = true,
  head,
  lines,
  open,
  onToggle,
  children,
  below,
}: {
  path?: string;
  onPick?: (picked: PickedFolder) => void;
  top?: boolean;
  head: string;
  lines: readonly SummaryLine[];
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  below?: ReactNode;
}) {
  return (
    <>
      {top && (
        <Row
          title={LIBRARY_WORDS.libraryFolder.label}
          tip={LIBRARY_WORDS.libraryFolder.tip}
          status={path ? <span title={path}>{wrapAtSlashes(path)}</span> : LIBRARY_WORDS.notSet}
          control={
            onPick && (
              <Button size="sm" variant="outline" onClick={() => void pickFolderOnMac().then((p) => p && onPick(p))}>
                {LIBRARY_WORDS.changeFolder}
              </Button>
            )
          }
        />
      )}
      <div className={cn("bg-muted/40", top && "border-t")}>
        <div className="flex items-center justify-between gap-2 px-3 pt-2 sm:px-4">
          <span className="text-xs text-muted-foreground">{head}</span>
          <Button
            size="icon"
            variant="ghost"
            aria-label={LIBRARY_WORDS.chooseEachFolder}
            aria-expanded={open}
            className="h-6 w-6 text-muted-foreground aria-expanded:bg-background aria-expanded:text-foreground"
            onClick={onToggle}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </div>
        {/* folded: the summary; unrolled: the rows. Each folds in its own one-row grid: in one shared two-row grid the hidden
            0fr row's content sizes the 1fr row, so the folded summary stood as tall as the rows (11-20) */}
        <div className={cn(fold, open ? "grid-rows-[0fr]" : "grid-rows-[1fr]")}>
          <div className="min-h-0 overflow-hidden" inert={open || undefined}>
            <dl aria-label="The folders" className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 px-3 pb-3 pt-1 text-xs transition-opacity motion-reduce:transition-none sm:px-4", open && "opacity-0")}>
              {lines.map((l) => (
                <div key={l.use} className="contents">
                  <dt className="text-muted-foreground">{FOLDER_LABELS[l.use]}</dt>
                  <dd className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate" title={l.folder}>
                      {l.folder}
                      {l.note && <span className="text-muted-foreground"> · {l.note}</span>}
                    </span>
                    {l.action && (
                      <Button size="sm" variant="ghost" className="h-6 shrink-0 px-2 text-xs" onClick={l.action.onClick}>
                        {l.action.label}
                      </Button>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
        <div className={cn(fold, open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
          <div className={cn("min-h-0 overflow-hidden bg-background transition-opacity motion-reduce:transition-none", !open && "opacity-0")} inert={!open || undefined}>
            <div className="border-t">{children}</div>
          </div>
        </div>
        {below}
      </div>
    </>
  );
}
