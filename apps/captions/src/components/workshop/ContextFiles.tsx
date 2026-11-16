import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight, Code, Eye, FileText, Folder, Loader2, X } from "lucide-react";
import type { KnowledgeSource } from "@contracts/knowledge";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Status } from "@/components/settings/ui";
import { sourceTextUrl } from "@/lib/workshop";
import { cn } from "@/lib/utils";

/**
 * Context files as files: one short row each (icon, name, type, size, date), folders that open, and a click opens the
 * file to read. What the AI filed a file as stays on the row's hover text; the list itself is names only.
 */

const EXT = /\.(md|markdown|txt|text|csv|tsv|json|ya?ml|html?|srt|vtt|pdf|docx|odt|epub|mp4|mov|m4v|webm|mkv|m4a|mp3|wav|aac)$/i;
const folderOf = (s: KnowledgeSource) => (s.name.includes("/") ? s.name.split("/")[0]! : "");

/** "kit/notes/voice.md" under "kit" → dir "notes/", base "voice", ext "MD". */
export function nameParts(name: string, folder = "") {
  const rest = folder ? name.slice(folder.length + 1) : name;
  const cut = rest.lastIndexOf("/") + 1;
  const file = rest.slice(cut);
  const ext = EXT.exec(file)?.[1] ?? "";
  return { dir: rest.slice(0, cut), base: ext ? file.slice(0, -ext.length - 1) : file, ext: ext.toUpperCase() };
}
export const sizeOf = (chars: number) => (chars < 1000 ? `${chars} B` : `${(chars / 1000).toFixed(chars >= 100_000 ? 0 : 1)}kB`);
export const dayOf = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(new Date(t).getFullYear() !== new Date().getFullYear() && { year: "numeric" }) });
const timeOf = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The date it was added, or where its reading is while it is not read. */
function Details({ s, off }: { s: KnowledgeSource; off?: boolean }) {
  if (s.status === "reading")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden /> Reading
      </span>
    );
  if (s.status === "queued") return <Status>{s.waitUntil ? `Resumes ${timeOf(s.waitUntil)}` : "Queued"}</Status>;
  if (s.status === "new") return <Status tone="attention">Not read</Status>;
  if (s.status === "failed")
    return (
      <span title={s.error}>
        <Status tone="broken">Not read</Status>
      </span>
    );
  if (off) return <Status>Off here</Status>;
  return <span className="text-xs text-muted-foreground">{dayOf(s.createdAt)}</span>;
}

const COLS = "grid grid-cols-[minmax(0,1fr)_4.5rem_6.5rem_1.75rem] items-center gap-x-3 px-3 sm:px-4";

function FileName({ name, folder, about }: { name: string; folder?: string; about?: string }) {
  const { dir, base, ext } = nameParts(name, folder);
  return (
    <span className="flex min-w-0 items-center gap-2.5" title={about}>
      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate text-sm text-foreground">
        {dir && <span className="text-muted-foreground">{dir}</span>}
        {base}
      </span>
      {ext && <span className="shrink-0 text-[11px] text-muted-foreground">{ext}</span>}
    </span>
  );
}

/** The list, in a card: a Name / Size / Details header, folders first (open), then loose files. */
export function ContextFileList({
  sources,
  onOpen,
  menu,
  isOff,
}: {
  sources: KnowledgeSource[];
  onOpen: (s: KnowledgeSource) => void;
  /** the row's `…` menu (and a Retry on a failed one); none when read only */
  menu?: (s: KnowledgeSource) => ReactNode;
  isOff?: (s: KnowledgeSource) => boolean;
}) {
  const [shut, setShut] = useState<Set<string>>(new Set());
  const folders = new Map<string, KnowledgeSource[]>();
  for (const s of sources) folders.set(folderOf(s), [...(folders.get(folderOf(s)) ?? []), s]);
  const loose = folders.get("") ?? [];
  folders.delete("");

  const row = (s: KnowledgeSource, folder = "") => (
    <div key={s.id} className={cn(COLS, "group py-1.5 hover:bg-accent/50")}>
      <button type="button" onClick={() => onOpen(s)} className={cn("min-w-0 py-1 text-left outline-none focus-visible:underline", folder && "pl-6")}>
        <FileName name={s.name} folder={folder} about={s.about} />
      </button>
      <span className="text-xs text-muted-foreground">{sizeOf(s.chars)}</span>
      <Details s={s} off={isOff?.(s)} />
      <span className="flex justify-end opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">{menu?.(s)}</span>
    </div>
  );

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 text-foreground [&>*+*]:border-t [&>*+*]:border-border/50">
      <div className={cn(COLS, "py-2 text-xs text-muted-foreground")}>
        <span>Name</span>
        <span>Size</span>
        <span>Details</span>
        <span />
      </div>
      {[...folders].map(([folder, rows]) => {
        const open = !shut.has(folder);
        const read = rows.filter((s) => s.status === "read").length;
        return [
          <div key={`f:${folder}`} className={cn(COLS, "py-1.5 hover:bg-accent/50")}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() =>
                setShut((c) => {
                  const n = new Set(c);
                  if (!n.delete(folder)) n.add(folder);
                  return n;
                })
              }
              className="flex min-w-0 items-center gap-2.5 py-1 text-left outline-none focus-visible:underline"
            >
              <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate text-sm text-foreground">{folder}</span>
              <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
            </button>
            <span className="text-xs text-muted-foreground">{sizeOf(rows.reduce((n, s) => n + s.chars, 0))}</span>
            <span className="text-xs text-muted-foreground">{read < rows.length ? `${read} of ${rows.length} read` : `${rows.length} files`}</span>
            <span />
          </div>,
          ...(open ? rows.map((s) => row(s, folder)) : []),
        ];
      })}
      {loose.map((s) => row(s))}
    </div>
  );
}

/** Markdown as a document: headings, tables, rules and code look like what was written. */
const DOC: Components = {
  h1: ({ children }) => <h1 className="mb-3 mt-8 text-2xl font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-7 text-xl font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-5 text-base font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1 mt-4 text-sm font-semibold first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-3 leading-relaxed first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5 leading-relaxed [&>p]:my-0">{children}</li>,
  hr: () => <hr className="my-6 border-border" />,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      {children}
    </a>
  ),
  blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-border pl-4 text-muted-foreground">{children}</blockquote>,
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>,
  pre: ({ children }) => <pre className="my-3 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs [&_code]:bg-transparent [&_code]:p-0">{children}</pre>,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-border px-3 py-2 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-border/60 px-3 py-2 align-top">{children}</td>,
};

/** The file's own text, fetched when it opens. */
function useText(id: string) {
  const [got, setGot] = useState<{ id: string; text?: string; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(sourceTextUrl(id))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("Couldn't open the file"))))
      .then(
        (text) => live && setGot({ id, text }),
        (e: Error) => live && setGot({ id, error: e.message }),
      );
    return () => {
      live = false;
    };
  }, [id]);
  return got?.id === id ? got : null;
}

/** An open file: the list on the left, the file on the right, read as a document or as its source. */
export function ContextFileViewer({
  sources,
  openId,
  onOpen,
  onClose,
  footer,
}: {
  sources: KnowledgeSource[];
  openId: string;
  onOpen: (id: string) => void;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const [source, setSource] = useState(false);
  const s = sources.find((x) => x.id === openId);
  const got = useText(openId);
  if (!s) return null;
  const { base, ext } = nameParts(s.name, folderOf(s));
  const markdown = ext === "MD" || ext === "MARKDOWN";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className="flex h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-6xl">
        <div className="hidden w-72 shrink-0 flex-col border-r border-border/60 md:flex">
          <DialogTitle className="px-4 pb-2 pt-4 text-sm font-semibold">Context files</DialogTitle>
          <div className="min-h-0 flex-1 overflow-y-auto px-2">
            {sources.map((x) => (
              <button
                key={x.id}
                type="button"
                onClick={() => onOpen(x.id)}
                className={cn("flex w-full items-center rounded-md px-2 py-2 text-left hover:bg-accent/60", x.id === openId && "bg-accent")}
              >
                <FileName name={x.name} folder={folderOf(x)} about={x.about} />
              </button>
            ))}
          </div>
          {footer && <div className="px-4 py-3 text-xs text-muted-foreground">{footer}</div>}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
            <p className="min-w-0 flex-1 truncate text-sm">
              <span className="text-foreground">{base}</span>
              <span className="text-muted-foreground">
                {ext && ` ${ext}`} · {sizeOf(s.chars)} · {dayOf(s.createdAt)}
              </span>
            </p>
            <DialogDescription className="sr-only">{s.about || s.name}</DialogDescription>
            {markdown && (
              <div className="flex rounded-md border border-border/60 p-0.5">
                <Button size="icon-xs" variant={source ? "ghost" : "secondary"} aria-label="Read" title="Read" aria-pressed={!source} onClick={() => setSource(false)}>
                  <Eye />
                </Button>
                <Button size="icon-xs" variant={source ? "secondary" : "ghost"} aria-label="Source" title="Source" aria-pressed={source} onClick={() => setSource(true)}>
                  <Code />
                </Button>
              </div>
            )}
            <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={onClose}>
              <X />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-10">
            {!got ? (
              <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" aria-label="Opening" />
            ) : got.error ? (
              <p className="text-sm text-red-600 dark:text-red-400">{got.error}</p>
            ) : markdown && !source ? (
              <div className="mx-auto max-w-3xl text-[15px] text-foreground">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={DOC}>
                  {got.text}
                </ReactMarkdown>
              </div>
            ) : (
              <pre className={cn("mx-auto max-w-3xl whitespace-pre-wrap break-words text-foreground", markdown ? "font-mono text-xs" : "font-sans text-sm leading-relaxed")}>{got.text}</pre>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
