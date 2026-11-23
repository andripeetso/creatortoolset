import { useRef, useState } from "react";
import { FolderUp, Plus, Upload } from "lucide-react";
import { CONTEXT_CAPACITY_CHARS } from "@contracts/knowledge";
import { Button } from "@/components/ui/button";
import { DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, EmptyRow, ErrorRow, LoadingRow, RowMenu, Section, SettingsDialog, SettingsDialogContent, Status, moveItems } from "@/components/settings/ui";
import { ContextFileList, ContextFileViewer } from "./ContextFiles";
import { useCachedList } from "@/lib/local-cache";
import { cn } from "@/lib/utils";
import { droppedFiles } from "../assistant/draft";
import { onlyPageMarks, pdfPages, pdfText } from "@/lib/pdf-text";
import { useWorkspace } from "@/lib/workspace";
import {
  addScan,
  addSource,
  addSourceLink,
  deleteSource,
  listSources,
  patchProject,
  patchSource,
  readSourceAgain,
  stopSourceRead,
  type KnowledgeSource,
} from "@/lib/workshop";

const ACCEPT = ".md,.markdown,.txt,.text,.pdf,.docx,.odt,.epub,text/plain,text/markdown,application/pdf,video/*,audio/*";
const SCAN_PAGES = 600; // the server's SOURCE_LIMITS.scanPages

type SourceBody = { text: string } | { file: string } | { pages: string[] };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const base64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** A video or recording, transcribed here in the browser (Whisper, the same as Caption Studio's local engine). */
async function videoText(file: File, say: (s: string) => void): Promise<string> {
  const [{ extractAudio }, { detectDevice, transcribeAudio }] = await Promise.all([import("@/lib/audio"), import("@/lib/transcribe")]);
  say(`Taking the sound out of ${file.name}…`);
  const { pcm } = await extractAudio(file);
  const words = await transcribeAudio(pcm, "Xenova/whisper-base", null, await detectDevice(), {
    onLoadProgress: (p) => say(`Loading the transcriber: ${Math.round(p * 100)}%`),
    onTranscribeStart: () => say(`Transcribing ${file.name}…`),
  }).promise;
  // a time mark every ~30 s, so a part can be found again
  let out = "";
  let mark = -30;
  for (const w of words) {
    if (w.start - mark >= 30) {
      out += `${out ? "\n" : ""}[${stamp(w.start)}] `;
      mark = w.start;
    }
    out += `${w.text.trim()} `;
  }
  if (!out.trim()) throw new Error(`No speech in ${file.name}`);
  return out.trim();
}

/** Any dropped file → what the server takes: text read here, a document for the server, or a scan's pages. */
async function toSource(file: File, say: (s: string) => void): Promise<SourceBody> {
  const n = file.name.toLowerCase();
  if (n.endsWith(".pdf") || file.type === "application/pdf") {
    const text = await pdfText(file, (i, total) => say(`Reading ${file.name}: page ${i} of ${total}`));
    if (!onlyPageMarks(text)) return { text };
    return { pages: await pdfPages(file, SCAN_PAGES, (i, total) => say(`Reading ${file.name}: page ${i} of ${total}`)) };
  }
  if (/\.(docx|odt|epub)$/.test(n)) return { file: await base64(file) };
  if (file.type.startsWith("video/") || file.type.startsWith("audio/") || /\.(mp4|mov|m4v|webm|mkv|m4a|mp3|wav|aac)$/.test(n)) return { text: await videoText(file, say) };
  if (TEXT_FILE.test(n) || file.type.startsWith("text/")) return { text: await file.text() };
  throw new Error(`${file.name}: not a PDF, Word, EPUB, video, Markdown or text file`);
}

const TEXT_FILE = /\.(md|markdown|txt|text|csv|tsv|json|yaml|yml|html?|srt|vtt)$/;
/** A file a folder brings that can be read; anything else in the folder (pictures, .DS_Store) is passed over. */
const readable = (f: File) => /\.(pdf|docx|odt|epub|mp4|mov|m4v|webm|mkv|m4a|mp3|wav|aac)$/i.test(f.name) || TEXT_FILE.test(f.name.toLowerCase()) || /^(text|video|audio)\//.test(f.type) || f.type === "application/pdf";
/** Its path in a dropped or picked folder ("kit/voice.md"), else its name. */
const pathOf = (f: File) => f.webkitRelativePath || f.name;
const count = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
/** "4 files · 2 read · 1 failed": the read count only while some, not all, are read. */
const tally = (list: KnowledgeSource[]) => {
  const read = list.filter((s) => s.status === "read").length;
  const failed = list.filter((s) => s.status === "failed").length;
  return [count(list.length), read > 0 && read < list.length && `${read} read`, failed > 0 && `${failed} failed`].filter(Boolean).join(" · ");
};

/**
 * Context files, drawn from the Settings kit in both places: the Content Workshop's Knowledge tab (the account's files as
 * the open workspace reads them: its own and the ones for every workspace, each moved or switched off from its row's
 * menu) and, with `projectId`, a workspace's own in Settings → Details (no workspace choice). Add is one button with a
 * menu (files, a folder, text, a link) and the whole section takes a drop; a folder opens into its files, one context
 * file each, under a folder row with its name. The list shows files as files (ContextFiles: name, type, size, date or
 * where its reading is); a click opens one to read. `readOnly`: the list and opening a file, nothing else.
 */
export function KnowledgePanel({ projectId, readOnly }: { projectId?: string; readOnly?: boolean } = {}) {
  const projects = useWorkspace((s) => s.projects);
  const current = useWorkspace((s) => s.currentProjectId);
  const here = projectId ?? current;
  // a saved list, live: a read running on the Mac saves as it goes, and each save refetches it (lib/local-cache)
  const { items: listed, setItems: setSources, error: loadError } = useCachedList<KnowledgeSource>(
    projectId ? `workshop/sources?ws=${projectId}` : "workshop/sources",
    () => listSources(projectId),
  );
  const sources = projectId ? listed.filter((s) => s.projectId === projectId) : listed;
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [adder, setAdder] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const put = (s: KnowledgeSource) => setSources((list) => (list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]));
  // kept to another workspace: it leaves this one's list, as the server's would
  const moved = (s: KnowledgeSource) => (s.projectId && here && s.projectId !== here && projects.some((p) => p.id === s.projectId) ? setSources((l) => l.filter((x) => x.id !== s.id)) : put(s));

  const add = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    setError(null);
    // a folder's files: the ones that can be read, each its own context file named by its path in the folder
    const all = Array.from(files);
    const list = all.filter((f) => !f.webkitRelativePath || readable(f));
    const skipped = all.length - list.length;
    const failed: string[] = [];
    for (const [i, file] of list.entries()) {
      const name = pathOf(file);
      const of = list.length > 1 ? ` (${i + 1} of ${list.length})` : "";
      try {
        setAdding(`Reading ${name}${of}…`);
        const body = await toSource(file, setAdding);
        setAdding(`Adding ${name}${of}…`);
        put("pages" in body ? await addScan(name, body.pages, (n) => setAdding(`Sending ${name}: page ${n} of ${body.pages.length}`), projectId) : await addSource({ name, ...body, projectId }));
      } catch (e) {
        failed.push(message(e));
      }
    }
    setAdding(null);
    const notes = [...(failed.length > 2 ? [`${count(failed.length)} not added: ${failed[0]}`] : failed), ...(skipped ? [`${count(skipped)} in the folder left out (pictures, other formats)`] : [])];
    if (notes.length) setError(notes.join(" · "));
  };

  const toggleProject = (sourceId: string) => {
    const p = projects.find((x) => x.id === here);
    if (!p) return;
    const off = p.off ?? [];
    return patchProject(p.id, { off: off.includes(sourceId) ? off.filter((x) => x !== sourceId) : [...off, sourceId] });
  };

  const ws = projects.find((p) => p.id === here);
  // a file for every workspace, seen from one workspace: it can be switched off there
  const shared = (s: KnowledgeSource) => !projectId && !s.projectId && !!ws;
  const isOff = (s: KnowledgeSource) => shared(s) && (ws?.off ?? []).includes(s.id);
  const menu = (s: KnowledgeSource) => (
    <RowMenu
      label="Context file actions"
      items={[
        ...(s.status === "reading" || s.status === "queued" ? [{ label: "Stop", onSelect: () => stopSourceRead(s.id).then(() => put({ ...s, status: "new", waitUntil: undefined })) }] : []),
        ...(s.status === "reading" ? [] : [{ label: s.status === "new" ? "Read" : "Read again", onSelect: () => readSourceAgain(s.id).then(put) }]),
        ...(shared(s) ? [{ label: isOff(s) ? "Turn on in this workspace" : "Turn off in this workspace", onSelect: () => toggleProject(s.id) }] : []),
        ...(projectId ? [] : moveItems(projects, s.projectId, (to) => patchSource(s.id, { projectId: to }).then(moved))),
        { label: "Delete", destructive: true, confirm: { title: "Delete this context file?" }, onSelect: () => deleteSource(s.id).then(() => setSources((l) => l.filter((x) => x.id !== s.id))) },
      ]}
    />
  );
  const failed = error || (!sources.length && loadError);
  const held = listed.filter((x) => !x.projectId || x.projectId === here).reduce((n, x) => n + x.chars, 0);

  return (
    <div
      // the whole section takes a drop; a dropped folder opens into its files (and its folders')
      {...(!readOnly && {
        onDragOver: (e: React.DragEvent) => {
          e.preventDefault();
          setOver(true);
        },
        onDragLeave: (e: React.DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false),
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          setOver(false);
          void droppedFiles(e.dataTransfer).then((d) => add(d.files), (err) => setError(message(err)));
        },
      })}
      className={cn("rounded-xl outline-2 outline-offset-8 outline-transparent transition-colors", over && "outline-dashed outline-ring")}
    >
      <Section
        id={projectId ? "workspace-files" : undefined}
        title="Context files"
        action={
          !readOnly && (
            <Button size="xs" variant="ghost" disabled={!!adding} onClick={() => setAdder(true)}>
              <Plus className="size-3" /> Add
            </Button>
          )
        }
      >
        <input ref={inputRef} type="file" multiple accept={ACCEPT} hidden onChange={(e) => void add(e.target.files).then(() => (e.target.value = ""))} />
        <input ref={folderRef} type="file" multiple {...{ webkitdirectory: "" }} hidden onChange={(e) => void add(e.target.files).then(() => (e.target.value = ""))} />
        {(adding || failed) && (
          <Card>
            {adding && <LoadingRow title={adding} />}
            {failed && <ErrorRow title={failed} />}
          </Card>
        )}
        {sources.length ? (
          <ContextFileList sources={sources} onOpen={(s) => setOpened(s.id)} menu={readOnly ? undefined : menu} isOff={isOff} />
        ) : (
          <Card>
            <EmptyRow title="No context files" description={readOnly ? undefined : "Drop files or a folder here"} />
          </Card>
        )}
        {sources.length > 0 && <Capacity sources={sources} held={held} />}
      </Section>
      {opened && <ContextFileViewer sources={sources} openId={opened} onOpen={setOpened} onClose={() => setOpened(null)} footer={room(sources, held).text} />}
      {adder && (
        <AddDialog
          projectId={projectId}
          onFiles={(files) => void add(files)}
          onPick={(folder) => (folder ? folderRef : inputRef).current?.click()}
          onAdded={put}
          onClose={() => setAdder(false)}
        />
      )}
    </div>
  );
}

/**
 * Adding, in one window: drop files or a folder on it (or choose them), add a link, or paste text. Files close it at once
 * and their reading shows in the list; a link or text closes it once the server has it.
 */
function AddDialog({ projectId, onFiles, onPick, onAdded, onClose }: {
  projectId?: string;
  onFiles: (files: File[]) => void;
  /** opens the panel's own file or folder picker */
  onPick: (folder: boolean) => void;
  onAdded: (s: KnowledgeSource) => void;
  onClose: () => void;
}) {
  const [over, setOver] = useState(false);
  const [link, setLink] = useState("");
  const [paste, setPaste] = useState<{ name: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Add pressed with its field empty: the field says what it needs
  const [needs, setNeeds] = useState<"link" | "text" | null>(null);
  const send = async (p: Promise<KnowledgeSource>) => {
    setBusy(true);
    setError(null);
    try {
      onAdded(await p);
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  const pick = (folder: boolean) => {
    onPick(folder);
    onClose();
  };
  return (
    <SettingsDialog open onOpenChange={(o) => !o && onClose()}>
      <SettingsDialogContent aria-describedby={undefined} className="sm:max-w-lg">
        <DialogTitle className="text-base">Add context files</DialogTitle>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(false);
            void droppedFiles(e.dataTransfer).then((d) => (onFiles(Array.from(d.files)), onClose()), (err) => setError(message(err)));
          }}
          className={cn("flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center", over ? "border-ring bg-accent/50" : "border-border")}
        >
          <div>
            <p className="text-sm text-foreground">Drop files or a folder</p>
            <p className="text-xs text-muted-foreground">PDF, Word, EPUB, Markdown, text or a video</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => pick(false)}>
              <Upload /> Choose files
            </Button>
            <Button size="sm" variant="outline" onClick={() => pick(true)}>
              <FolderUp /> Choose a folder
            </Button>
          </div>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!link.trim()) return setNeeds("link");
            void send(addSourceLink(link.trim(), projectId));
          }}
        >
          <Input value={link} onChange={(e) => (setLink(e.target.value), setNeeds(null))} aria-invalid={needs === "link" || undefined} aria-label="Link" placeholder="A link: an article, a YouTube video" autoComplete="off" />
          <Button type="submit" size="sm" variant="outline" disabled={busy}>
            Add
          </Button>
        </form>
        {paste ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const text = paste.text.trim();
              if (!text) return setNeeds("text");
              void send(addSource({ name: paste.name.trim() || text.split("\n", 1)[0]!.slice(0, 80), text: paste.text, projectId }));
            }}
          >
            <Input value={paste.name} onChange={(e) => setPaste({ ...paste, name: e.target.value })} aria-label="Name" placeholder="Name" autoComplete="off" />
            <Textarea autoFocus value={paste.text} onChange={(e) => (setPaste({ ...paste, text: e.target.value }), setNeeds(null))} aria-invalid={needs === "text" || undefined} aria-label="Text" placeholder="Paste or write it here" rows={8} className="max-h-[40vh] text-sm" />
            <Button type="submit" size="sm" className="self-end" disabled={busy}>
              Add text
            </Button>
          </form>
        ) : (
          <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => setPaste({ name: "", text: "" })}>
            Paste text
          </Button>
        )}
        {(error || needs) && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error || (needs === "link" ? "Needs a link" : "Needs text")}
          </p>
        )}
      </SettingsDialogContent>
    </SettingsDialog>
  );
}

/** One quiet line: how many files, how many of them are read (while not all are), and how much of the workspace's room they take (amber from 90%). */
const room = (sources: KnowledgeSource[], held: number) => {
  const pct = Math.min(100, (held / CONTEXT_CAPACITY_CHARS) * 100);
  return { pct, text: `${tally(sources)} · ${pct < 1 ? "under 1" : Math.round(pct)}% of the workspace's context used` };
};
function Capacity({ sources, held }: { sources: KnowledgeSource[]; held: number }) {
  const { pct, text } = room(sources, held);
  return (
    <p className="px-0.5">
      <Status tone={pct >= 90 ? "attention" : undefined}>{text}</Status>
    </p>
  );
}
