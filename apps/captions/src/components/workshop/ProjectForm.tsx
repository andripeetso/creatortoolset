import { useEffect, useId, useRef, useState } from "react";
import { FileText, Folder, Loader2, Paperclip, Undo2, X } from "lucide-react";
import { PLATFORMS, type SocialPlatform } from "@contracts/connectors";
import { listAccounts } from "@/lib/instagram";
import {
  PROJECT_NOTES_MAX,
  attachKind,
  draftProjectNotes,
  filePath,
  foldProjectInstructions,
  materialOf,
  type FileFiling,
  type ProjectFields,
  type WorkshopProject,
} from "@/lib/workshop";
import { PROJECT_COLORS, projectColor, type ProjectColor } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConnectorsSection } from "@/components/settings/ConnectorsSection";
import { Card, Row, Section } from "@/components/settings/ui";
import { cn } from "@/lib/utils";
import { LanguageSelect } from "../LanguageSelect";
import { CtMark } from "../CtMark";
import { droppedFiles } from "../assistant/draft";
import { KnowledgePanel } from "./KnowledgePanel";

const EMPTY: ProjectFields = { name: "", audience: "", voice: "", cta: "", notes: "", accountId: null };

/**
 * The form's starting values. The old audience, voice and CTA fields are moved into the instructions, where they can be
 * read and changed. The prompts still read those fields (api/lib/workshop/prompt.ts renderInstructions, review.ts
 * audienceOf), so they are emptied only when their text is in the instructions whole: one the 20,000 limit would cut
 * stays in its field, as it was.
 */
function fieldsFrom(initial?: WorkshopProject): ProjectFields {
  // knowledge lives in the account's Knowledge now (sources); the form never sends the old context files back
  const { knowledge: _old, ...cur } = initial ? { ...EMPTY, ...initial, accountId: initial.accountId ?? null } : EMPTY;
  const notes = foldProjectInstructions(cur);
  const whole = [cur.audience, cur.voice, cur.cta].every((v) => !v.trim() || notes.includes(v.trim()));
  return whole ? { ...cur, notes, audience: "", voice: "", cta: "" } : cur;
}

/** Setup's payload: the name, the colour and the handles that have text. No accountId, so no Analyzer account and no fetch. */
export function setupProjectFields(
  f: { name: string; color?: string },
  where: Partial<Record<SocialPlatform, string>>,
): ProjectFields {
  const handles: Partial<Record<SocialPlatform, string>> = {};
  for (const [id, raw] of Object.entries(where) as Array<[SocialPlatform, string | undefined]>) {
    const h = (raw ?? "").trim();
    if (h) handles[id] = h;
  }
  return { name: f.name.trim(), audience: "", voice: "", cta: "", notes: "", color: f.color, handles };
}

const DOC = /\.(docx|odt|epub)$/i;
const ACCEPT = ".txt,.md,.markdown,.pdf,.docx,.odt,.epub,text/*,application/pdf";
const readable = (file: File) => DOC.test(file.name) || ["text", "pdf"].includes(attachKind(file));
/** At most this many files (a dropped folder brings all of its own); DRAFT_FILES in api/workshop.ts. */
const MAX_FILES = 300;
/** A file kept as the project's Knowledge when it is saved, with what Write it for me said of it. */
export type KeptFile = { file: File; about?: string; kind?: string };
/** Dropped files by their folder (a loose file on its own), for one chip each. */
const byFolder = (files: File[]) => {
  const out = new Map<string, File[]>();
  for (const f of files) {
    const p = filePath(f);
    const top = p.includes("/") ? p.split("/")[0]! : p;
    out.set(top, [...(out.get(top) ?? []), f]);
  }
  return [...out];
};

/**
 * A workspace's own settings: name, colour, the instructions always in the prompt (written from whatever is dropped in),
 * the language of its videos and, once it is saved, its own context files (added and read here; every AI in the
 * workspace reads them, lib/workshop/context.ts). Which account-wide knowledge, frameworks and rules a workspace uses is
 * switched where they live (the Knowledge tab), not here: what it has switched off (`off`) goes back as it was.
 *
 * Drawn three ways from the same rows: `settings` is the page Settings → Details (a section with one Save; its social
 * accounts are their own page there), the Manage workspaces window (its accounts under the rows, Cancel and Save kept
 * in view), and variant "setup", the first-run step: name, colour and where it posts (handles only).
 */
export function ProjectForm({
  initial,
  busy,
  onSave,
  onCancel,
  formId,
  variant,
  settings,
  onReady,
  children,
}: {
  initial?: WorkshopProject;
  busy: boolean;
  /** `files`: what was dropped on the instructions, kept as the workspace's own context files once it is saved. */
  onSave: (fields: ProjectFields, files: KeptFile[]) => void | Promise<unknown>;
  /** Absent = no Cancel (the first-run setup, where a workspace is required). */
  onCancel?: () => void;
  /** First-run setup: the form gets this id and the setup window's own button submits it (no buttons here). */
  formId?: string;
  /** "setup": the first-run step. No accounts, instructions or context files; handles only. */
  variant?: "setup";
  /** The page Settings → Details: no accounts block, and Save is on only while something changed. */
  settings?: boolean;
  /** Tells the parent whether the name has text, so it can enable its own Create button. */
  onReady?: (ready: boolean) => void;
  /** More rows under the form's own (a new workspace's upload choice) */
  children?: React.ReactNode;
}) {
  const setup = variant === "setup";
  const [f, setF] = useState<ProjectFields>(() => fieldsFrom(initial));
  // what the server has, as text: on Settings → Details Save is on only while the form differs from it
  const [saved, setSaved] = useState(() => JSON.stringify(f));
  // setup's edit shows the saved handles, so saving again keeps them (and the page can change them)
  const [where, setWhere] = useState<Partial<Record<SocialPlatform, string>>>(() => (setup && initial?.handles ? { ...initial.handles } : {}));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // files dropped on the instructions: written from (Write it for me) and kept as the project's Knowledge; what Write it
  // for me said of each; and what the box held before it wrote
  const [dropped, setDropped] = useState<File[]>([]);
  const [filing, setFiling] = useState<FileFiling[]>([]);
  const [before, setBefore] = useState<{ notes: string; files: File[]; filing: FileFiling[] } | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [over, setOver] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  // the <form> holds no rows of its own: the accounts' buttons sit in this box too, and inside a form the first of them
  // would be what Enter presses. The name, the handles and the submit button belong to it by `form=`.
  const ownId = useId();
  const fid = formId ?? `project-form-${ownId}`;
  const alive = useRef(true);
  const set = (k: "name" | "notes") => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }));
  const locked = busy || pending || drafting;
  const togglePlatform = (id: SocialPlatform) =>
    setWhere((cur) => {
      if (id in cur) {
        const { [id]: _gone, ...rest } = cur;
        return rest;
      }
      return { ...cur, [id]: "" };
    });
  // a folder's files it can't read (pictures, videos) are left out quietly; a loose one is named
  const addFiles = (files: FileList | File[], folder = false) => {
    const list = [...files];
    const bad = list.filter((x) => !readable(x));
    const ok = list.filter(readable);
    const room = MAX_FILES - dropped.length;
    setError(
      bad.length && !folder
        ? `Can't read ${bad.map((x) => x.name).join(", ")} (text, PDF, Word, OpenDocument or EPUB only)`
        : folder && !ok.length
          ? "No text, PDF, Word, OpenDocument or EPUB file in the folder"
          : ok.length > room
            ? `Only the first ${MAX_FILES} files are read`
            : null,
    );
    setDropped((cur) => [...cur, ...ok].slice(0, MAX_FILES));
  };
  // only files: dragged or pasted text still lands in the box
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
  const canWrite = !!f.notes.trim() || dropped.length > 0 || !!initial?.accountId;
  const write = async () => {
    setError(null);
    setDrafting(true);
    try {
      // an @handle the Analyzer already reads brings its bio and posts; the project's own Instagram always does
      // what is in the box (a description, links, @handles, instructions so far) is read with the files, and the draft takes its place
      const context = f.notes;
      const handles = new Set((context.match(/@[\w.]+/g) ?? []).map((h) => h.slice(1).toLowerCase()));
      const known = handles.size ? await listAccounts("", { projectId: null }).catch(() => []) : [];
      const accountIds = [initial?.accountId, ...known.filter((a) => handles.has(a.username.toLowerCase())).map((a) => a.id)].filter((x): x is string => !!x);
      const files = await Promise.all(dropped.map(materialOf));
      const { notes, files: filed = [] } = await draftProjectNotes({ name: f.name, text: context.trim(), accountIds, files });
      if (!alive.current) return;
      setBefore({ notes: context, files: dropped, filing });
      setF((cur) => ({ ...cur, notes }));
      // the files stay, to look things up in later; only what it says a writer never needs goes
      const out = new Set(filed.filter((x) => !x.keep).map((x) => x.file));
      setFiling(filed);
      setDropped((cur) => cur.filter((x) => !out.has(filePath(x))));
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setDrafting(false);
    }
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    onReady?.(f.name.trim().length > 0);
  }, [f.name, onReady]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (setup && !f.name.trim()) return;
    setPending(true);
    const said = new Map(filing.map((x) => [x.file, x]));
    const kept = dropped.map((file): KeptFile => ({ file, about: said.get(filePath(file))?.about, kind: said.get(filePath(file))?.kind }));
    // the workspace's Analyzer account (f.accountId) goes back as it was: accounts are connected on their own page.
    // Setup sends the name, colour and handles; a workspace it edits keeps its instructions
    const fields = setup ? { ...setupProjectFields(f, where), ...(initial ? { audience: initial.audience, voice: initial.voice, cta: initial.cta, notes: initial.notes } : {}) } : f;
    void Promise.resolve(onSave(fields, setup ? [] : kept))
      .then(() => {
        // Settings → Details stays open after a save (its onSave rejects when it failed): the files are the workspace's
        // context files now, and a second Save must not add them again. The other windows close the form themselves,
        // and one that failed keeps the files for the next try
        if (!alive.current || !settings) return;
        setDropped([]);
        setFiling([]);
        setBefore(null);
        setSaved(JSON.stringify(f));
      })
      .catch((err) => alive.current && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => alive.current && setPending(false));
  };
  const changed = JSON.stringify(f) !== saved || dropped.length > 0;
  const quiet = "text-muted-foreground hover:text-foreground";

  const rows = (
    <Card>
      <Row
        id="workspace-name"
        title={<label htmlFor={`${fid}-name`}>Name</label>}
        control={<Input id={`${fid}-name`} form={fid} autoFocus={!settings} required value={f.name} onChange={set("name")} className="h-8 sm:w-72" />}
      />
      <Row
        id="workspace-colour"
        title="Colour"
        control={
          <div className="flex max-w-80 flex-wrap gap-2 sm:justify-end" role="radiogroup" aria-label="Workspace colour">
            {(Object.keys(PROJECT_COLORS) as ProjectColor[]).map((c) => {
              const on = projectColor({ id: initial?.id ?? "new", color: f.color }) === c;
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={c}
                  title={c}
                  onClick={() => setF((cur) => ({ ...cur, color: c }))}
                  className={cn("size-6 rounded-full transition-transform", PROJECT_COLORS[c].dot, on ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : "hover:scale-110")}
                />
              );
            })}
          </div>
        }
      />
      {setup && (
        <Row title="Platforms">
          <div className="flex flex-wrap gap-1.5">
            {PLATFORMS.map((p) => (
              <Button key={p.id} type="button" size="xs" variant={p.id in where ? "secondary" : "outline"} aria-pressed={p.id in where} disabled={locked} onClick={() => togglePlatform(p.id)} className="rounded-full">
                {p.label}
              </Button>
            ))}
          </div>
          {PLATFORMS.filter((p) => p.id in where).map((p) => (
            <label key={p.id} className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="w-28 shrink-0">{p.label} handle</span>
              <Input
                value={where[p.id] ?? ""}
                form={fid}
                onChange={(e) => setWhere((cur) => ({ ...cur, [p.id]: e.target.value }))}
                placeholder="@handle"
                disabled={locked}
                spellCheck={false}
                className="h-8 sm:w-72"
              />
            </label>
          ))}
        </Row>
      )}
      {!setup && (
        <Row id="workspace-instructions" title={<label htmlFor="project-notes">Instructions</label>}>
          {/* one box, like the chat's: files dropped, pasted or picked show at its top, the clip and Write it for me at its foot */}
          <div
            className={cn("rounded-xl border border-input transition-colors focus-within:border-ring", over && "border-ring bg-accent/40")}
            onDragOver={(e) => {
              if (!hasFiles(e) || locked) return;
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
            onDrop={(e) => {
              setOver(false);
              if (!hasFiles(e) || locked) return;
              e.preventDefault();
              // a dropped folder is opened into its files (and its folders' files)
              void droppedFiles(e.dataTransfer).then(
                ({ files, folder }) => alive.current && addFiles(files, folder),
                (err: unknown) => alive.current && setError(`Can't open that folder: ${err instanceof Error ? err.message : String(err)}`),
              );
            }}
            onPaste={(e) => {
              if (!e.clipboardData.files.length || locked) return;
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }}
          >
            {dropped.length ? (
              <div className="flex flex-wrap gap-2 px-3 pt-3">
                {byFolder(dropped).map(([name, files]) => (
                  <div key={name} className="group/chip relative motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95" title={files.map(filePath).join("\n")}>
                    <div className="flex h-14 max-w-52 items-center gap-1.5 rounded-lg border bg-muted px-2.5 text-[11px]">
                      {files.length > 1 || filePath(files[0]!).includes("/") ? (
                        <Folder className="size-4 shrink-0 text-[var(--tint)]" aria-hidden />
                      ) : (
                        <FileText className="size-4 shrink-0 text-[var(--tint)]" aria-hidden />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-foreground">{name}</span>
                        <span className="block text-muted-foreground">
                          {files.length > 1 || filePath(files[0]!).includes("/") ? `${files.length} ${files.length === 1 ? "file" : "files"}` : name.split(".").pop()?.toUpperCase()}
                        </span>
                      </span>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${name}`}
                      disabled={drafting}
                      onClick={() => setDropped((cur) => cur.filter((x) => !files.includes(x)))}
                      className="absolute -top-1.5 -right-1.5 rounded-full border bg-background p-0.5 text-muted-foreground opacity-0 shadow-sm hover:text-foreground focus-visible:opacity-100 group-hover/chip:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <textarea
              id="project-notes"
              value={f.notes}
              onChange={(e) => (set("notes")(e), setBefore(null))}
              maxLength={PROJECT_NOTES_MAX}
              disabled={drafting}
              placeholder="Audience, voice and what never to say"
              // grows with the text: one scroll for the window, not a second one inside the box
              className="block min-h-24 w-full resize-none bg-transparent px-3.5 pt-3 text-sm text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground"
            />
            <div className="flex items-center gap-1 px-2 pb-2">
              <input ref={pick} type="file" multiple hidden accept={ACCEPT} onChange={(e) => (e.target.files && addFiles(e.target.files), (e.target.value = ""))} />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => pick.current?.click()}
                disabled={locked}
                aria-label="Add files"
                title="Add files or a folder: text, PDF, Word, OpenDocument or EPUB"
                className={cn("rounded-full", quiet)}
              >
                <Paperclip />
              </Button>
              <span className="flex-1" />
              <span className="px-1 text-[10px] tabular-nums text-muted-foreground" title="Always in the prompt">
                {f.notes.length.toLocaleString("en-US")}/{PROJECT_NOTES_MAX.toLocaleString("en-US")}
              </span>
              {before ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => (setF((cur) => ({ ...cur, notes: before.notes })), setDropped(before.files), setFiling(before.filing), setBefore(null))}
                  className={cn("rounded-full", quiet)}
                >
                  <Undo2 /> Undo
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void write()}
                disabled={locked || !canWrite}
                title="Write the instructions from what is in the box and the files"
                className="rounded-full"
              >
                {drafting ? <Loader2 className="animate-spin" /> : <CtMark className="size-3.5" />}
                {drafting ? "Writing…" : "Write it for me"}
              </Button>
            </div>
          </div>
          {filing.some((x) => !x.keep) ? (
            <p className="pt-2 text-xs text-muted-foreground">
              Left out:{" "}
              {filing
                .filter((x) => !x.keep)
                .map((x) => (
                  <span key={x.file} title={x.why}>
                    {x.file.split("/").pop()}
                  </span>
                ))
                .reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), [])}
            </p>
          ) : null}
        </Row>
      )}
      {!setup && (
        <Row
          id="workspace-language"
          title={<label htmlFor="project-language">Video language</label>}
          control={
            <LanguageSelect
              id="project-language"
              value={f.languages?.[0] ?? ""}
              onChange={(code) => setF((cur) => ({ ...cur, languages: code ? [code] : [] }))}
              disabled={locked}
              className="h-8 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:w-64"
            />
          }
        />
      )}
      {children}
    </Card>
  );
  const failed = error ? (
    <p role="alert" className="text-xs text-red-600 dark:text-red-400">
      {error}
    </p>
  ) : null;
  const save = (
    <Button type="submit" form={fid} size="sm" disabled={locked || f.name.trim().length === 0 || (settings && !changed)}>
      {(busy || pending) && <Loader2 className="animate-spin" />}
      {initial ? "Save" : "Create"}
    </Button>
  );
  // the <form> holds no rows of its own (see `fid`)
  const form = <form id={fid} className="contents" onSubmit={submit} />;
  const files = !setup && initial && (
    <Section id="workspace-files" title="Context files">
      <KnowledgePanel projectId={initial.id} />
    </Section>
  );

  if (settings)
    return (
      <>
        <Section title="Details">
          {form}
          {rows}
          {failed}
          <div className="flex justify-end">{save}</div>
        </Section>
        {files}
      </>
    );

  return (
    <div className="flex flex-col gap-6">
      {form}
      <div className="flex flex-col gap-2.5">
        {rows}
        {failed}
      </div>
      {!setup && initial && (
        // a new workspace adds its accounts in step 2, once it exists (ProjectList's AccountsStep)
        <ConnectorsSection projectId={initial.id} back={`/projects?edit=${initial.id}`} title="Social accounts" />
      )}
      {files}
      {/* Cancel / Save stay in view at the bottom while the form scrolls. -bottom-4 is the Workspaces window's own bottom
          padding (py-4): stuck at 0 the bar would stop above it, and the text would scroll by underneath */}
      {!formId && (
        <div className="sticky -bottom-4 z-10 flex justify-end gap-2 border-t border-border bg-background/95 py-3 backdrop-blur">
          {onCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {save}
        </div>
      )}
    </div>
  );
}
