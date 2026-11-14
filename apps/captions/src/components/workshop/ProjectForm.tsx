import { useEffect, useId, useRef, useState } from "react";
import { FileText, Loader2, Paperclip, Undo2, X } from "lucide-react";
import { PLATFORMS, type SocialPlatform } from "@contracts/connectors";
import { listAccounts } from "@/lib/instagram";
import {
  PROJECT_NOTES_MAX,
  attachKind,
  draftProjectNotes,
  fileBase64,
  foldProjectInstructions,
  type ProjectFields,
  type WorkshopProject,
} from "@/lib/workshop";
import { pdfText } from "@/lib/pdf-text";
import { PROJECT_COLORS, projectColor, type ProjectColor } from "@/lib/workspace";
import { ConnectorsSection } from "@/components/settings/ConnectorsSection";
import { LanguageSelect } from "../LanguageSelect";
import { CtMark } from "../CtMark";

const EMPTY: ProjectFields = { name: "", audience: "", voice: "", cta: "", notes: "", accountId: null };

const input =
  "w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500";

function fieldsFrom(initial?: WorkshopProject): ProjectFields {
  // knowledge lives in the account's Knowledge now (sources); the form never sends the old context files back
  const { knowledge: _old, ...cur } = initial ? { ...EMPTY, ...initial, accountId: initial.accountId ?? null } : EMPTY;
  return { ...cur, notes: foldProjectInstructions(cur), audience: "", voice: "", cta: "" };
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

/**
 * A project: name, colour, its accounts, the instructions always in the prompt (written for you from whatever you drop
 * in, if you like) and the language of its videos. Which knowledge, frameworks and rules a project uses is switched where
 * they live (the Knowledge tab), not here: what it has switched off (`off`) goes back as it was. variant "setup" is
 * the first-run project step: name, colour, where it posts (handles only).
 */
export function ProjectForm({
  initial,
  busy,
  onSave,
  onCancel,
  formId,
  variant,
  onReady,
  made,
}: {
  initial?: WorkshopProject;
  busy: boolean;
  onSave: (fields: ProjectFields) => void | Promise<unknown>;
  /** Absent = no Cancel (the first-run setup, where a project is required). */
  onCancel?: () => void;
  /** First-run setup: the form gets this id and the setup window's own button submits it (no box, no buttons here). */
  formId?: string;
  /** "setup": the first-run project step. No accounts, instructions or knowledge; handles only. */
  variant?: "setup";
  /** Tells the parent whether the name has text, so it can enable its own Create button. */
  onReady?: (ready: boolean) => void;
  /** The project was just created in this form: what is left is connecting its accounts, and the button says Done. */
  made?: boolean;
}) {
  const setup = variant === "setup";
  const [f, setF] = useState<ProjectFields>(() => fieldsFrom(initial));
  // setup's edit shows the saved handles, so saving again keeps them (and the page can change them)
  const [where, setWhere] = useState<Partial<Record<SocialPlatform, string>>>(() => (setup && initial?.handles ? { ...initial.handles } : {}));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // files dropped on the instructions, to write them from ("Write it for me"); and what the box held before it did
  const [dropped, setDropped] = useState<File[]>([]);
  const [before, setBefore] = useState<{ notes: string; files: File[] } | null>(null);
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
  const addFiles = (files: FileList | File[]) => {
    const list = [...files];
    const bad = list.filter((x) => !readable(x));
    setError(bad.length ? `Can't read ${bad.map((x) => x.name).join(", ")}: drop text, PDF, Word, OpenDocument or EPUB` : null);
    setDropped((cur) => [...cur, ...list.filter(readable)].slice(0, 5));
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
      let text = context.trim();
      const files: Array<{ name: string; data: string }> = [];
      for (const file of dropped) {
        if (DOC.test(file.name)) files.push({ name: file.name, data: await fileBase64(file) });
        else text += `\n\nThe file ${file.name}:\n${(attachKind(file) === "pdf" ? await pdfText(file) : await file.text()).slice(0, 20_000)}`;
      }
      const { notes } = await draftProjectNotes({ name: f.name, text, accountIds, files });
      if (!alive.current) return;
      setBefore({ notes: context, files: dropped });
      setF((cur) => ({ ...cur, notes }));
      setDropped([]);
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

  return (
    <div className={formId ? "flex flex-col gap-4" : "flex flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"}>
      <form
      id={fid}
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        if (setup && !f.name.trim()) return;
        // what was dropped in to write from would be lost without a word
        if (dropped.length) {
          setError("Write the instructions from the files first (Write it for me), or remove them.");
          return;
        }
        setPending(true);
        // the project's Analyzer account (f.accountId) goes back as it was: accounts are connected below, not typed here
        void Promise.resolve(onSave(setup ? setupProjectFields(f, where) : { ...f, audience: "", voice: "", cta: "" }))
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => alive.current && setPending(false));
      }}
      />
      <label className="text-[11px] text-zinc-400">
        Name
        <input
          form={fid}
          autoFocus={!made}
          required
          value={f.name}
          onChange={set("name")}
          placeholder={setup ? "My brand" : undefined}
          className={`${input} mt-1`}
        />
      </label>
      <div>
        <p className="text-[11px] text-zinc-400">Colour</p>
        <div className="mt-1.5 flex flex-wrap gap-2" role="radiogroup" aria-label="Project colour">
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
                className={`h-7 w-7 rounded-full transition-transform ${PROJECT_COLORS[c].dot} ${on ? "ring-2 ring-zinc-200 ring-offset-2 ring-offset-zinc-900" : "hover:scale-110"}`}
              />
            );
          })}
        </div>
      </div>
      {setup ? (
        <div>
          <p className="text-[11px] text-zinc-400">Where do you post?</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {PLATFORMS.map((p) => {
              const on = p.id in where;
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  disabled={locked}
                  onClick={() => togglePlatform(p.id)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] ${on ? "border-violet-500/50 bg-violet-500/10 text-zinc-100" : "border-zinc-800 text-zinc-400 hover:text-zinc-200"}`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          {PLATFORMS.filter((p) => p.id in where).map((p) => (
            <label key={p.id} className="mt-2 block text-[11px] text-zinc-400">
              {p.label} handle
              <input
                value={where[p.id] ?? ""}
                form={fid}
                onChange={(e) => setWhere((cur) => ({ ...cur, [p.id]: e.target.value }))}
                placeholder="@yourhandle"
                disabled={locked}
                spellCheck={false}
                className={`${input} mt-1`}
              />
            </label>
          ))}
          <p className="mt-1 text-[10px] text-zinc-600">Only the handle is saved. Nothing is fetched.</p>
        </div>
      ) : (
        <div>
          <p className="text-[11px] text-zinc-400">Accounts</p>
          {initial ? (
            <div className="mt-1">
              <ConnectorsSection projectId={initial.id} back={`/projects?edit=${initial.id}`} />
            </div>
          ) : null}
          <p className="mt-1 text-[10px] text-zinc-600">
            {initial
              ? "Optional. Skip it if you like: they can be connected any time in Settings → Social accounts."
              : "Optional. Once it's made you can connect them here, or any time later in Settings → Social accounts."}
          </p>
        </div>
      )}
      {!setup && (
        <div className="text-[11px] text-zinc-400">
          <label htmlFor="project-notes">Instructions</label>
          {/* one box, like the chat's: files dropped, pasted or picked show at its top, the clip and Write it for me at its foot */}
          <div
            className={`mt-1 rounded-2xl border bg-zinc-950 transition-colors focus-within:border-zinc-600 ${over ? "border-zinc-500 bg-zinc-900" : "border-zinc-800"}`}
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
              addFiles(e.dataTransfer.files);
            }}
            onPaste={(e) => {
              if (!e.clipboardData.files.length || locked) return;
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }}
          >
            {dropped.length ? (
              <div className="flex flex-wrap gap-2 px-3 pt-3">
                {dropped.map((file, i) => (
                  <div key={`${file.name}-${i}`} className="group/chip relative motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95" title={file.name}>
                    <div className="flex h-14 max-w-52 items-center gap-1.5 rounded-lg border bg-muted px-2.5 text-[11px]">
                      <FileText className="size-4 shrink-0 text-[var(--tint)]" aria-hidden />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-foreground">{file.name}</span>
                        <span className="block uppercase text-muted-foreground">{file.name.split(".").pop()}</span>
                      </span>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      disabled={drafting}
                      onClick={() => setDropped((cur) => cur.filter((_, j) => j !== i))}
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
              placeholder="Who you write for, how you sound, what never to say. Or drop in links, @handles and files, and have it written for you."
              // grows with the text: one scroll for the window, not a second one inside the box
              className="block min-h-24 w-full resize-none bg-transparent px-3.5 pt-3 text-sm text-zinc-100 outline-none [field-sizing:content] placeholder:text-zinc-600"
            />
            <div className="flex items-center gap-1 px-2 pb-2">
              <input ref={pick} type="file" multiple hidden accept={ACCEPT} onChange={(e) => (e.target.files && addFiles(e.target.files), (e.target.value = ""))} />
              <button
                type="button"
                onClick={() => pick.current?.click()}
                disabled={locked}
                aria-label="Add files"
                title="Add files: text, PDF, Word, OpenDocument or EPUB (or drop them here)"
                className="flex size-8 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
              >
                <Paperclip className="size-4" />
              </button>
              <span className="flex-1" />
              <span className="px-1 text-[10px] tabular-nums text-zinc-600" title="Always in the prompt, so keep it short">
                {f.notes.length.toLocaleString("en-US")}/{PROJECT_NOTES_MAX.toLocaleString("en-US")}
              </span>
              {before ? (
                <button
                  type="button"
                  onClick={() => (setF((cur) => ({ ...cur, notes: before.notes })), setDropped(before.files), setBefore(null))}
                  className="flex h-8 items-center gap-1 rounded-full px-2.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <Undo2 className="size-3.5" /> Undo
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void write()}
                disabled={locked || !canWrite}
                title="Write the instructions from what is in the box and the files"
                className="flex h-8 items-center gap-1.5 rounded-full px-3 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
              >
                {drafting ? <Loader2 className="size-3.5 animate-spin" /> : <CtMark className="size-3.5" />}
                {drafting ? "Writing…" : "Write it for me"}
              </button>
            </div>
          </div>
        </div>
      )}
      {error ? <p className="text-[10px] text-red-400">{error}</p> : null}
      {!setup && (
        <div className="text-[11px] text-zinc-400">
          <label htmlFor="project-language">Spoken in its videos</label>
          <LanguageSelect
            id="project-language"
            value={f.languages?.[0] ?? ""}
            onChange={(code) => setF((cur) => ({ ...cur, languages: code ? [code] : [] }))}
            disabled={locked}
            className={`${input} mt-1`}
          />
        </div>
      )}
      {/* Cancel / Save stay in view at the bottom while the form scrolls */}
      {!formId && <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex justify-end gap-2 rounded-b-xl border-t border-zinc-800 bg-zinc-900/95 px-4 py-3 backdrop-blur">
        {onCancel && !made && (
          <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">
            Cancel
          </button>
        )}
        <button
          type="submit"
          form={fid}
          disabled={locked || f.name.trim().length === 0}
          className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {(busy || pending) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {made ? "Done" : initial ? "Save" : "Create project"}
        </button>
      </div>}
    </div>
  );
}
