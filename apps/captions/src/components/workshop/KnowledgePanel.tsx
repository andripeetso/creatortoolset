import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Loader2, RotateCw, Upload } from "lucide-react";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { onlyPageMarks, pdfPages, pdfText } from "@/lib/pdf-text";
import { useWorkspace } from "@/lib/workspace";
import {
  SOURCE_KINDS,
  addScan,
  addSource,
  addSourceLink,
  deleteSource,
  knowledgeSizeLabel,
  listSources,
  patchProject,
  patchSource,
  readSourceAgain,
  sourceTextUrl,
  type KnowledgeSource,
  type SourceKind,
  type SourceSection,
} from "@/lib/workshop";

const ACCEPT = ".md,.markdown,.txt,.text,.pdf,.docx,.odt,.epub,text/plain,text/markdown,application/pdf,video/*,audio/*";
const SCAN_PAGES = 600; // the server's SOURCE_LIMITS.scanPages
const field = "w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] text-zinc-100 outline-none focus:border-violet-500";
const small = "flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50";

const sectionLine = (s: SourceSection) => `L${s.from}-L${s.to} ${s.title}${s.about ? ` — ${s.about}` : ""}`;
/** "L12-L80 Title — about" lines back into sections; a line that doesn't parse is dropped. */
export function parseSectionLines(text: string): SourceSection[] {
  return text
    .split("\n")
    .map((l) => /^\s*L?(\d+)\s*[-–]\s*L?(\d+)\s+(.+?)(?:\s+—\s+(.*))?\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ from: Number(m[1]), to: Number(m[2]), title: m[3]!.trim(), about: (m[4] ?? "").trim() }));
}

type SourceBody = { text: string } | { file: string } | { pages: string[] };

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
    onTranscribeStart: () => say(`Transcribing ${file.name} (on this computer, nothing uploaded)…`),
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
  if (!out.trim()) throw new Error(`Nothing is said in ${file.name}`);
  return out.trim();
}

/** Any dropped file → what the server takes: text read here, a document for the server, or a scan's pages. */
async function toSource(file: File, say: (s: string) => void): Promise<SourceBody> {
  const n = file.name.toLowerCase();
  if (n.endsWith(".pdf") || file.type === "application/pdf") {
    const text = await pdfText(file, (i, total) => say(`Reading ${file.name}: page ${i} of ${total}`));
    if (!onlyPageMarks(text)) return { text };
    say(`${file.name} is a scan: preparing its pages for Claude to read`);
    return { pages: await pdfPages(file, SCAN_PAGES, (i, total) => say(`${file.name}: page ${i} of ${total}`)) };
  }
  if (/\.(docx|odt|epub)$/.test(n)) return { file: await base64(file) };
  if (file.type.startsWith("video/") || file.type.startsWith("audio/") || /\.(mp4|mov|m4v|webm|mkv|m4a|mp3|wav|aac)$/.test(n)) return { text: await videoText(file, say) };
  if (/\.(md|markdown|txt|text)$/.test(n) || file.type.startsWith("text/")) return { text: await file.text() };
  throw new Error(`${file.name}: drop PDF, Word, EPUB, a video, Markdown or text (save Pages files as PDF)`);
}

/**
 * The account's knowledge: drop anything to write from — books, studies, old scripts,
 * references, brand docs. Claude reads each once and files it; the filing shows here to check and change, and
 * which projects read each one is switched here or in a project's form.
 */
export function KnowledgePanel() {
  const projects = useWorkspace((s) => s.projects);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [paste, setPaste] = useState<{ name: string; text: string } | null>(null);
  const [link, setLink] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => listSources().then(setSources).catch((e) => setError(String(e instanceof Error ? e.message : e))), []);
  useEffect(() => void load(), [load]);
  // a read runs in the background on the Mac: look again until none is running
  const reading = sources.some((s) => s.status === "reading");
  useEffect(() => {
    if (!reading) return;
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [reading, load]);

  const put = (s: KnowledgeSource) => setSources((list) => (list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]));
  const act = (p: Promise<unknown>) => p.catch((e) => setError(e instanceof Error ? e.message : String(e)));

  const add = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    setError(null);
    for (const file of Array.from(files)) {
      try {
        setAdding(`Reading ${file.name}…`);
        const body = await toSource(file, setAdding);
        setAdding(`Adding ${file.name}…`);
        put("pages" in body ? await addScan(file.name, body.pages, (i) => setAdding(`Sending ${file.name}: page ${i} of ${body.pages.length}`)) : await addSource({ name: file.name, ...body }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    setAdding(null);
  };

  const toggleProject = (projectId: string, sourceId: string) => {
    const p = projects.find((x) => x.id === projectId);
    if (!p) return;
    const off = p.off ?? [];
    void act(patchProject(p.id, { off: off.includes(sourceId) ? off.filter((x) => x !== sourceId) : [...off, sourceId] }));
  };

  return (
    <section>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void add(e.dataTransfer.files);
        }}
        className={`mb-3 rounded-lg border border-dashed px-4 py-5 text-center ${over ? "border-violet-500 bg-violet-500/5" : "border-zinc-800"}`}
      >
        <p className="text-[13px] text-zinc-200">Drop books, studies, old scripts, videos, references, brand docs</p>
        <p className="mt-0.5 text-[11px] text-zinc-500">
          PDF (scans too), Word, EPUB, videos, Markdown or text, or a link. Claude reads each one once and files it: what it is,
          what it answers, where its parts are. Every project uses it unless you switch it off.
        </p>
        <div className="mt-3 flex justify-center gap-2">
          <button type="button" onClick={() => inputRef.current?.click()} disabled={!!adding} className={small}>
            <Upload className="h-3 w-3" /> Choose files
          </button>
          <button type="button" onClick={() => setPaste(paste ? null : { name: "", text: "" })} disabled={!!adding} className={small}>
            Paste text
          </button>
        </div>
        <form
          className="mx-auto mt-2 flex max-w-md gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!link.trim()) return;
            setAdding(`Reading ${link.trim()}…`);
            void act(addSourceLink(link.trim()).then((s) => (put(s), setLink("")))).finally(() => setAdding(null));
          }}
        >
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Or a link: an article, a YouTube video" className={field} />
          <button type="submit" disabled={!link.trim() || !!adding} className={small}>
            Add
          </button>
        </form>
        <input ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => void add(e.target.files).then(() => (e.target.value = ""))} />
        {adding && (
          <p className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-zinc-400">
            <Loader2 className="h-3 w-3 animate-spin" /> {adding}
          </p>
        )}
      </div>
      {paste && (
        <form
          className="mb-3 flex flex-col gap-1.5 rounded-lg border border-zinc-800 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(addSource({ name: paste.name.trim() || paste.text.trim().split("\n", 1)[0]!.slice(0, 80), text: paste.text }).then((s) => (put(s), setPaste(null))));
          }}
        >
          <input value={paste.name} onChange={(e) => setPaste({ ...paste, name: e.target.value })} placeholder="Name" className={field} />
          <textarea value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} placeholder="Paste it here" className={`${field} min-h-32`} />
          <div className="flex justify-end">
            <button type="submit" disabled={!paste.text.trim()} className={small}>
              Add
            </button>
          </div>
        </form>
      )}
      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
      {sources.length === 0 ? (
        <p className="py-8 text-center text-sm text-zinc-600">Nothing yet.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {sources.map((s) => (
            <SourceRow
              key={s.id}
              s={s}
              open={open === s.id}
              projects={projects}
              onToggle={() => setOpen(open === s.id ? null : s.id)}
              onSave={(fields) => act(patchSource(s.id, fields).then(put))}
              onRead={() => void act(readSourceAgain(s.id).then(put))}
              onDelete={() => act(deleteSource(s.id).then(() => setSources((l) => l.filter((x) => x.id !== s.id))))}
              onProject={(pid) => toggleProject(pid, s.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SourceRow({
  s,
  open,
  projects,
  onToggle,
  onSave,
  onRead,
  onDelete,
  onProject,
}: {
  s: KnowledgeSource;
  open: boolean;
  projects: ReturnType<typeof useWorkspace.getState>["projects"];
  onToggle: () => void;
  onSave: (fields: Parameters<typeof patchSource>[1]) => Promise<unknown>;
  onRead: () => void;
  onDelete: () => Promise<unknown>;
  onProject: (projectId: string) => void;
}) {
  const [draft, setDraft] = useState({ title: s.title ?? "", about: s.about ?? "", uses: (s.uses ?? []).join("\n"), sections: (s.sections ?? []).map(sectionLine).join("\n") });
  useEffect(() => {
    setDraft({ title: s.title ?? "", about: s.about ?? "", uses: (s.uses ?? []).join("\n"), sections: (s.sections ?? []).map(sectionLine).join("\n") });
  }, [s.title, s.about, s.uses, s.sections]);
  const only = s.projectId ? projects.find((p) => p.id === s.projectId) : undefined;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2">
      <div className="flex items-start gap-2">
        <button type="button" onClick={onToggle} className="mt-0.5 text-zinc-500 hover:text-zinc-200" aria-label={open ? "Close" : "Open"}>
          <Chevron className="h-3.5 w-3.5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-zinc-100">
            <button type="button" onClick={onToggle} className="truncate text-left">
              {s.title || s.name}
            </button>
            <select
              value={s.kind ?? ""}
              onChange={(e) => void onSave({ kind: e.target.value as SourceKind })}
              className="rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-300 outline-none"
              aria-label="What it is"
            >
              {!s.kind && <option value="">not filed</option>}
              {SOURCE_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-zinc-600">{knowledgeSizeLabel(s.chars)}</span>
            {s.status === "reading" && (
              <span className="flex items-center gap-1 text-[10px] text-violet-300">
                <Loader2 className="h-3 w-3 animate-spin" /> Claude is reading it
              </span>
            )}
            {s.status === "new" && <span className="text-[10px] text-amber-300">not read yet</span>}
            {s.status === "failed" && <span className="text-[10px] text-red-400">read failed{s.error ? `: ${s.error}` : ""}</span>}
            {s.readCost !== undefined && <span className="text-[10px] text-zinc-600">read for ${s.readCost.toFixed(2)} API-equivalent</span>}
          </p>
          {s.about && !open && <p className="mt-0.5 line-clamp-2 text-[11px] text-zinc-500">{s.about}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <select
              value={s.projectId ?? ""}
              onChange={(e) => void onSave({ projectId: e.target.value || null })}
              className="rounded bg-transparent py-px text-[10px] text-zinc-500 outline-none hover:text-zinc-300"
              aria-label="Which projects use it"
            >
              <option value="">Every project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  Only {p.name}
                </option>
              ))}
              {s.projectId && !only && <option value={s.projectId}>Only a deleted project</option>}
            </select>
            {s.projectId ? null : (
              projects.map((p) => {
                const on = !(p.off ?? []).includes(s.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onProject(p.id)}
                    title={on ? `${p.name} uses it: click to switch off` : `${p.name} doesn't use it: click to switch on`}
                    className={`rounded-full border px-1.5 py-px text-[10px] ${on ? "border-violet-500/50 bg-violet-500/10 text-zinc-200" : "border-zinc-800 text-zinc-600 line-through"}`}
                  >
                    {p.name}
                  </button>
                );
              })
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={onRead} disabled={s.status === "reading"} className={small} title="Claude reads it again and files it fresh">
            <RotateCw className="h-3 w-3" /> {s.status === "new" ? "Read" : "Read again"}
          </button>
          <ConfirmButton
            label="Delete"
            confirmLabel="Click again"
            onConfirm={() => void onDelete()}
            className="rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-red-300"
            armedClassName="!bg-red-500/10 !text-red-200"
          />
        </div>
      </div>
      {open && (
        <form
          className="mt-2 flex flex-col gap-2 border-t border-zinc-800 pt-2 text-[11px] text-zinc-400"
          onSubmit={(e) => {
            e.preventDefault();
            void onSave({
              title: draft.title,
              about: draft.about,
              uses: draft.uses.split("\n").map((u) => u.trim()).filter(Boolean),
              sections: parseSectionLines(draft.sections),
            });
          }}
        >
          <p className="text-[10px] text-zinc-600">
            {s.name} ·{" "}
            <a href={sourceTextUrl(s.id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-violet-400 hover:underline">
              the text it reads <ExternalLink className="h-2.5 w-2.5" />
            </a>
            {s.readAt ? ` · filed ${new Date(s.readAt).toLocaleDateString()}` : ""}
          </p>
          <label>
            Title
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={`${field} mt-0.5`} />
          </label>
          <label>
            What it is
            <textarea value={draft.about} onChange={(e) => setDraft({ ...draft, about: e.target.value })} className={`${field} mt-0.5 min-h-16 [field-sizing:content]`} />
          </label>
          <label>
            What it answers (one per line)
            <textarea value={draft.uses} onChange={(e) => setDraft({ ...draft, uses: e.target.value })} className={`${field} mt-0.5 min-h-16 [field-sizing:content]`} />
          </label>
          <label>
            Its parts (L first-L last Title — what's in it)
            <textarea value={draft.sections} onChange={(e) => setDraft({ ...draft, sections: e.target.value })} className={`${field} mt-0.5 min-h-16 font-mono text-[11px] [field-sizing:content]`} />
          </label>
          <div className="flex justify-end">
            <button type="submit" className={small}>
              Save
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
