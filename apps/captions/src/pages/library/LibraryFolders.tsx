import { useState, type ReactNode } from "react";
import { ChevronDown, Folder, Search, Trash2, X } from "lucide-react";
import type { Collection } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The Media Library's folders, as one button beside the search: it names the open folder and lists the folders, the
 * saved searches and the Trash, with New folder and, while there is a search, Save this search. Until the app's shared
 * folder views (src/components/browse/) take its place: the page passes the folders and the open one, and gets the
 * choices back, so the swap is in one place.
 */
export function LibraryFolders({
  folders,
  open,
  onOpen,
  onMake,
  onSaveSearch,
}: {
  /** the library's folders and saved searches */
  folders: Collection[];
  /** "all", "trash" or a folder's id */
  open: string;
  onOpen: (id: string) => void;
  /** a new folder with this name; it resolves once made */
  onMake: (name: string) => Promise<unknown>;
  /** only while there is a search: keeps it as a folder */
  onSaveSearch?: () => void;
}) {
  const [shown, setShown] = useState(false);
  const [name, setName] = useState("");
  const current = open === "trash" ? "Trash" : (folders.find((f) => f.id === open)?.name ?? "Folders");
  const pick = (id: string) => {
    onOpen(id);
    setShown(false);
  };
  const item = (id: string, label: string, icon: ReactNode, count?: number) => (
    <button
      key={id}
      type="button"
      onClick={() => pick(id)}
      aria-pressed={open === id}
      className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-500/10", open === id && "bg-zinc-500/15 font-medium")}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? <span className="shrink-0 text-xs text-zinc-500">{count}</span> : null}
    </button>
  );

  return (
    <div className="flex items-center">
      <Popover open={shown} onOpenChange={setShown}>
        <PopoverTrigger asChild>
          <Button variant={open === "all" ? "outline" : "default"} size="sm" className="max-w-48">
            <Folder className="h-4 w-4" />
            <span className="truncate">{current}</span>
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="flex w-64 flex-col gap-0.5 p-1.5">
          <div role="group" aria-label="Folders" className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
            {item("all", "All clips", <Folder className="h-4 w-4 shrink-0 text-zinc-500" />)}
            {folders.map((f) =>
              item(f.id, f.name, f.kind === "smart" ? <Search className="h-4 w-4 shrink-0 text-zinc-500" /> : <Folder className="h-4 w-4 shrink-0 text-zinc-500" />, f.count),
            )}
            {item("trash", "Trash", <Trash2 className="h-4 w-4 shrink-0 text-zinc-500" />)}
          </div>
          <form
            className="mt-1 flex items-center gap-1.5 border-t border-zinc-500/20 pt-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void onMake(name.trim()).then(() => setName(""), () => {}); // a failure is said by the page
            }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New folder" aria-label="New folder" className="h-8 min-w-0 flex-1" />
            <Button type="submit" size="sm" variant="ghost" disabled={!name.trim()}>
              Make
            </Button>
          </form>
          {onSaveSearch && (
            <Button
              size="sm"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                onSaveSearch();
                setShown(false);
              }}
            >
              <Search className="h-4 w-4" />
              Save this search as a folder
            </Button>
          )}
        </PopoverContent>
      </Popover>
      {open !== "all" && (
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="All clips" title="All clips" onClick={() => onOpen("all")}>
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
