import { useEffect, useState } from "react";
import { Check, ChevronDown, Copy, Download } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { fetchExportMarkdown, listExports, runExport, type WorkshopExport } from "@/lib/workshop";

/** Today in the owner's time zone, for the note's frontmatter. */
function localDay(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function okOrThrow(r: Response): Promise<Response> {
  if (r.ok) return r;
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  throw new Error(j?.error || `Request failed (${r.status})`);
}

/** Save a response as a file under the server's name. */
async function save(r: Response): Promise<void> {
  const name = /filename\*=UTF-8''([^;]+)/.exec(r.headers.get("Content-Disposition") ?? "")?.[1];
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name ? decodeURIComponent(name) : "Untitled.md";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The list's bulk export: each session saved the way its own Export saves it, one after the other.
 * Sessions with no reel or carousel words are skipped; returns how many were saved.
 */
export async function saveObsidianMany(ids: string[]): Promise<{ saved: number; skipped: number }> {
  let saved = 0;
  for (const id of ids) {
    try {
      await saveObsidian(id);
      saved++;
    } catch {
      continue;
    }
    await new Promise((r) => setTimeout(r, 400)); // downloads in a burst can be dropped
  }
  return { saved, skipped: ids.length - saved };
}

/**
 * A session's file from one of its download routes, saved under the server's name. A reel and a carousel: one file each,
 * one after the other; the route answers their names as JSON then.
 */
async function saveFiles(route: string, init?: RequestInit): Promise<void> {
  const sep = route.includes("?") ? "&" : "?";
  const get = async (part?: number) => okOrThrow(await fetch(part === undefined ? route : `${route}${sep}part=${part}`, init));
  const first = await get();
  if ((first.headers.get("Content-Type") ?? "").includes("application/json")) {
    const { parts } = (await first.json()) as { parts: string[] };
    for (let i = 0; i < parts.length; i++) {
      await save(await get(i));
      await new Promise((r) => setTimeout(r, 400)); // two downloads at once can be dropped as a burst
    }
    return;
  }
  await save(first);
}

/** The reel as an Obsidian note (the built-in export). */
const saveObsidian = (sessionId: string) => saveFiles(`/api/workshop/sessions/${sessionId}/obsidian.md?day=${localDay()}`);

/** One of the account's Settings → Exports: a download is saved; a plugin export is queued for the Obsidian plugin to write. */
async function runCustom(sessionId: string, exp: WorkshopExport): Promise<void> {
  const query = `day=${localDay()}`;
  if (exp.target === "download") return saveFiles(`/api/workshop/sessions/${sessionId}/export/${exp.id}?${query}`, { method: "POST" });
  await okOrThrow(await runExport(sessionId, exp.id, query));
}

/** Header control: copy the session as Markdown, or save the same file. */
export function ExportMarkdown({
  sessionId,
  onError,
  onExported,
}: {
  sessionId: string;
  filename?: string;
  onError?: (e: unknown) => void;
  /** An export moves the session to In Production, like a share: the page shows the new status. */
  onExported?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  // the account's own exports (Settings → Exports); the built-in one is the "Save as Markdown" item below
  const [exports, setExports] = useState<WorkshopExport[]>([]);
  useEffect(() => void listExports().then((list) => setExports(list.filter((e) => e.id !== "obsidian")), () => {}), []);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Export Markdown"
        >
          {copied ? <Check className="h-3 w-3" /> : <Download className="h-3 w-3" />}
          {copied ? "Copied" : "Export"}
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem
          onSelect={() => {
            void fetchExportMarkdown(sessionId)
              .then((md) => navigator.clipboard.writeText(md))
              .then(() => {
                setCopied(true);
                onExported?.();
                window.setTimeout(() => setCopied(false), 1600);
              })
              .catch((e) => onError?.(e));
          }}
        >
          <Copy className="h-3.5 w-3.5" /> Copy as Markdown
        </DropdownMenuItem>
        {/* one way to save: the author's Obsidian note, named after the session */}
        <DropdownMenuItem onSelect={() => void saveObsidian(sessionId).then(() => onExported?.(), (e) => onError?.(e))}>
          <Download className="h-3.5 w-3.5" /> Save as Markdown
        </DropdownMenuItem>
        {exports.map((exp) => (
          <DropdownMenuItem key={exp.id} onSelect={() => void runCustom(sessionId, exp).then(() => onExported?.(), (e) => onError?.(e))}>
            <Download className="h-3.5 w-3.5" /> {exp.target === "plugin" ? `Export to ${exp.name}` : exp.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
