import { FolderOpen, FolderSearch } from "lucide-react";
import { EVERY_WORKSPACE, type StorageFolder, type StorageView } from "@contracts/storage";
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu";
import { STORAGE_API, call, canRevealFolder, revealFolder } from "@/components/settings/StorageRows";
import { useCachedLoad } from "@/lib/local-cache";
import { currentWorkspace } from "@/lib/current-workspace";

/**
 * Two of the Library's ⋯ items (Andri 11-19: "a button to open the media location so I can drop things in by hand, and
 * one to check the source folder for new media"):
 * - Show Source media in Finder: this workspace's Source media folders on this Mac, where the Mac app can show them
 *   (canRevealFolder). One opens it; several are a submenu, each by its name and computer. None: no item.
 * - Look for new files: `onLook` (the page runs the check and says what it found). Only where `canLook`.
 */
export function SourceMediaItems({ canLook, onLook, onError }: { canLook: boolean; onLook: () => void; onError: (e: string) => void }) {
  const store = useCachedLoad<StorageView>(STORAGE_API, () => call<StorageView>(STORAGE_API, "GET"), { own: true });
  const ws = currentWorkspace();
  const inWorkspace = (f: StorageFolder) => !ws || f.workspace === EVERY_WORKSPACE || f.workspace === ws || !!f.workspaces?.includes(ws);
  const shown = (store.data?.folders ?? []).filter((f) => f.role === "footage" && inWorkspace(f) && canRevealFolder(f));
  const reveal = (f: StorageFolder) => void revealFolder(f).catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  return (
    <>
      {shown.length === 1 && (
        <DropdownMenuItem onSelect={() => reveal(shown[0]!)}>
          <FolderOpen /> Show Source media in Finder
        </DropdownMenuItem>
      )}
      {shown.length > 1 && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FolderOpen /> Show Source media in Finder
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {shown.map((f) => (
              <DropdownMenuItem key={f.id} onSelect={() => reveal(f)}>
                {f.name} <span className="ml-auto pl-4 text-xs text-muted-foreground">This Mac</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      {canLook && (
        <DropdownMenuItem onSelect={onLook}>
          <FolderSearch /> Look for new files
        </DropdownMenuItem>
      )}
    </>
  );
}
