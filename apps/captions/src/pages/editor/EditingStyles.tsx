import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { MAX_VERSIONS, type EditorDefaults } from "@contracts/editor";
import type { EditStepChoice, StepRow } from "@contracts/editor-steps";
import { ANIMATION_BRIEF_MAX, cutLine, PACES, PACE_NAME, PLAYBOOK_MAX, PUNCHES, STYLE_NAME_MAX, STYLE_NOTES_MAX, WORKING_SIZES, type AnimationStyle, type EditingStyle, type EditingStyleInput, type FinishedEdit, type Pace, type StyleLearned, type StyleProposal, type WorkingSize } from "@contracts/editor-styles";
import { placeOf } from "@contracts/skills";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { RowMenu } from "@/components/settings/ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { createStyle, deleteStyle, dismissProposal, getEditorDefaults, getEditSteps, keepProposal, listAnimationStyles, listFinished, proposalStillUrl, proposeStyle, removeFinished, removeLearned, setDefaultStyle, updateStyle } from "@/lib/editor";
import { listCollections, listLibraries } from "@/lib/library";
import { listSkills } from "@/lib/skills";
import { AnimationSheet } from "./AnimationStyles";

/**
 * The AI Editor's Editing styles tab: the person's styles as cards, and the sheet one is made and changed in. A style
 * is the choices of New edit under a name, with notes in their own words; New edit picks one (pages/EditorPage.tsx) and
 * an edit keeps its own copy. `open` is the style in the sheet, "new" for a new one; the page owns it, so its own
 * "New editing style" button opens the same sheet. `onChat`: an AI answers in the assistant, so a first style is set up
 * by talking to it (the empty tab's button), with the form one quiet button away.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const select = "h-9 rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm";

/** A pace as the sheet offers it: its name and what it does to the pauses. */
const PACE_OPTION: Record<Pace, string> = { tight: "Tight: pauses cut out", natural: "Natural: short pauses stay" };
/** The Animation style select's last row: it opens a new animation style's sheet. */
const NEW_ANIMATION = "+new";

/** What a style sets, in one line under its name. */
export const styleLine = (s: EditingStyle): string =>
  [PACE_NAME[s.pace], `${s.versions} ${s.versions === 1 ? "version" : "versions"}`, s.targetS ? `${s.targetS} s` : "", s.size ? `${s.size.w}×${s.size.h}` : ""].filter(Boolean).join(" · ");

export type OpenStyle = EditingStyle | "new" | null;

/** A working size as a select's value: "1080x1920", or "footage" for none (the footage's own). */
export const sizeKey = (s: WorkingSize | null | undefined): string => (s ? `${s.w}x${s.h}` : "footage");
export const sizeOfKey = (k: string): WorkingSize | null => {
  const s = WORKING_SIZES.find((x) => sizeKey(x) === k);
  return s ? { w: s.w, h: s.h } : null;
};
export const SIZE_OPTIONS = [...WORKING_SIZES.map((s) => ({ value: sizeKey(s), label: s.name })), { value: "footage", label: "From the footage" }];
/** A new style's working size: vertical HD. */
const NEW_SIZE = sizeKey(WORKING_SIZES[0]);

/** A copy of a style under "<name> copy". A B-roll folder deleted since the style was made cannot be saved again, so the copy is then made without it. */
export async function duplicateStyle(s: EditingStyle): Promise<EditingStyle> {
  const { id: _id, createdAt: _c, updatedAt: _u, ...fields } = s;
  const body = { ...fields, name: `${s.name} copy`.slice(0, STYLE_NAME_MAX) };
  return createStyle(body).catch((e) => (s.brollCollectionId ? createStyle({ ...body, brollCollectionId: null }) : Promise.reject(e)));
}

/**
 * Suggest a style: the reference is read and a suggestion (StyleProposal) comes back as a card; nothing is a style until
 * the person keeps it on its sheet. A video or a link goes through the assistant (`onVideo`), which finds or fetches it.
 * In the tab's bar (pages/EditorPage.tsx), so an empty tab keeps its one button.
 */
export function SuggestButton({ onMade, onVideo }: { onMade: (p: StyleProposal) => void; onVideo?: () => void }) {
  const pick = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const run = (from: File[] | "finished") => {
    setBusy(true);
    proposeStyle(from).then(onMade, (e) => toast.error(message(e))).finally(() => setBusy(false));
  };
  return (
    <>
      <input ref={pick} type="file" accept="image/*" multiple hidden onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = "";
        if (files.length) run(files);
      }} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Suggest a style
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => pick.current?.click()}>From pictures</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run("finished")}>From finished edits</DropdownMenuItem>
          {onVideo && <DropdownMenuItem onSelect={onVideo}>From a video or link</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

export function EditingStyles({ styles, open, onOpen, onChanged, onChat, editable = true, defaultId = null, proposals = [], proposal, onProposal }: {
  editable?: boolean;
  styles: EditingStyle[];
  open: OpenStyle;
  onOpen: (s: OpenStyle) => void;
  onChanged: () => Promise<unknown>;
  onChat?: () => void;
  /** the style New edit opens on in this workspace */
  defaultId?: string | null;
  proposals?: StyleProposal[];
  /** the suggestion in its sheet; the page owns it, so the assistant's link opens it */
  proposal?: StyleProposal | null;
  onProposal?: (p: StyleProposal | null) => void;
}) {
  return (
    <>
      {proposals.length > 0 && (
        <ul aria-label="Suggested" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {proposals.map((p) => (
            <li key={p.id} className="relative">
              <button type="button" onClick={() => onProposal?.(p)} className="flex h-full w-full flex-col gap-1.5 rounded-xl border border-dashed border-violet-500/50 p-3.5 text-left transition-colors hover:border-violet-500">
                <span className="flex w-full items-center gap-2 pr-8">
                  <span className="truncate text-sm font-medium">{p.style.name}</span>
                  <span className="shrink-0 rounded bg-violet-500/15 px-1.5 text-[11px] text-violet-500">Suggested</span>
                </span>
                <span className="truncate text-xs text-zinc-500">{p.fromLabel}</span>
                <span className="line-clamp-2 text-xs text-zinc-500">{p.seen}</span>
              </button>
              <div className="absolute right-2 top-2.5">
                {editable && <RowMenu label={`More for ${p.style.name}`} items={[{ label: "Delete suggestion", destructive: true, onSelect: () => dismissProposal(p.id).then(onChanged) }]} />}
              </div>
            </li>
          ))}
        </ul>
      )}
      {styles.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16">
          {editable && <Button size="sm" onClick={onChat ?? (() => onOpen("new"))}>
            <Plus className="h-4 w-4" />
            New editing style
          </Button>}
          {editable && onChat && (
            <Button size="sm" variant="ghost" className="text-zinc-500" onClick={() => onOpen("new")}>
              Use a form
            </Button>
          )}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {styles.map((s) => (
            <li key={s.id} className="relative">
              <button
                type="button"
                onClick={() => onOpen(s)}
                className="flex h-full w-full flex-col gap-1.5 rounded-xl border border-zinc-500/20 p-3.5 text-left transition-colors hover:border-violet-500/60"
              >
                <span className="flex w-full items-center gap-2 pr-8">
                  <span className="truncate text-sm font-medium">{s.name}</span>
                  {s.id === defaultId && <span className="shrink-0 rounded bg-zinc-500/15 px-1.5 text-[11px] text-zinc-500">Default</span>}
                </span>
                <span className="text-xs text-zinc-500">{styleLine(s)}</span>
                {s.notes && <span className="line-clamp-2 whitespace-pre-line text-xs text-zinc-500">{s.notes}</span>}
              </button>
              <div className="absolute right-2 top-2.5">
{editable &&                 <RowMenu
                  label={`More for ${s.name}`}
                  items={[
                    s.id === defaultId
                      ? { label: "Remove default", onSelect: () => setDefaultStyle(null).then(onChanged) }
                      : { label: "Use as default", onSelect: () => setDefaultStyle(s.id).then(onChanged) },
                    { label: "Duplicate", onSelect: () => duplicateStyle(s).then(onChanged) },
                    { label: "Delete", destructive: true, confirm: { title: `Delete “${s.name}”?` }, onSelect: () => deleteStyle(s.id).then(onChanged) },
                  ]}
                />}
              </div>
            </li>
          ))}
        </ul>
      )}
      {open && <StyleSheet editable={editable} key={open === "new" ? "new" : `${open.id}:${open.updatedAt}`} style={open === "new" ? null : open} onClose={() => onOpen(null)} onSaved={onChanged} />}
      {proposal && !open && <StyleSheet editable={editable} key={proposal.id} style={null} proposal={proposal} onClose={() => onProposal?.(null)} onSaved={onChanged} />}
    </>
  );
}

/** The folders B-roll can come from: every folder of the person's Media Library, named with its library when there are several. */
export async function brollFolders(): Promise<{ id: string; name: string }[]> {
  const libraries = await listLibraries();
  const lists = await Promise.all(libraries.map((l) => listCollections(l.id).catch(() => [])));
  return libraries.flatMap((l, i) => lists[i]!.map((c) => ({ id: c.id, name: libraries.length > 1 ? `${l.name}: ${c.name}` : c.name })));
}

/**
 * One style's sheet. The grade and the steps are sent only when changed here: a style that says nothing about them
 * takes the person's own defaults when an edit is made. A select with nothing to choose is not drawn (one grade, no
 * folder, no step in this app, no skill). The skills offered are the AI Editor script skills (the person's own, and
 * the ones their packs and plug-ins bring), and the one the style names from before skills had a place, so it can be
 * taken off. The Animation style select is always there: its last row makes one, which is then picked; the skill is sent only when changed here, so one the style names that is switched off for now is kept. Under Save, the edits finished with the style, each with an × that takes it off for good.
 * A style an AI researched shows its playbook under the notes as "Researched": changed here it is the person's, Delete
 * takes it off (both on Save). Under the finished edits, what approved edits taught it ("From finished edits"): the
 * rounds each took, its numbers and the person's own lines, each with an × that takes it off at once.
 */
/** `proposal`: a suggestion's sheet, its fields filled from it; Keep style makes the style (and the cards' look) of what is on it. */
export function StyleSheet({ style, proposal, onClose, onSaved, editable = true }: { style: EditingStyle | null; proposal?: StyleProposal; onClose: () => void; onSaved: (saved: EditingStyle) => Promise<unknown>; editable?: boolean }) {
  const from = style ?? proposal?.style;
  const [name, setName] = useState(from?.name ?? "");
  const [notes, setNotes] = useState(from?.notes ?? "");
  const [versions, setVersions] = useState(from?.versions ?? 1);
  const [targetS, setTargetS] = useState(from?.targetS ? String(from.targetS) : "");
  const [pace, setPace] = useState<Pace>(from?.pace ?? "tight");
  const [punch, setPunch] = useState(from?.punch ?? 1.15);
  const [cards, setCards] = useState(proposal?.animation?.brief ?? "");
  const [keepCards, setKeepCards] = useState(!!proposal?.animation);
  const [size, setSize] = useState(style ? sizeKey(style.size) : NEW_SIZE);
  const [folder, setFolder] = useState(style?.brollCollectionId ?? "");
  const [animation, setAnimation] = useState(style?.animation ?? "");
  const [passes, setPasses] = useState(!!style?.passes);
  const [animations, setAnimations] = useState<AnimationStyle[]>([]);
  const [makingAnimation, setMakingAnimation] = useState(false);
  const [grade, setGrade] = useState<string | null>(null); // null: not changed here
  const [steps, setSteps] = useState<EditStepChoice[] | null>(null); // null: not changed here
  const [defaults, setDefaults] = useState<EditorDefaults | null>(null);
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<StepRow[]>([]);
  const [skill, setSkill] = useState<string | null>(null); // null: not changed here
  const [skills, setSkills] = useState<{ id: string; name: string }[]>([]);
  const [finished, setFinished] = useState<FinishedEdit[]>([]);
  const [playbook, setPlaybook] = useState<string | null>(style?.playbook?.text ?? null); // null: none, or deleted here
  const [learned, setLearned] = useState<StyleLearned[]>(style?.learned ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getEditorDefaults().then(setDefaults, () => {});
    brollFolders().then(setFolders, () => {});
    listAnimationStyles().then((v) => setAnimations(v.styles ?? []), () => {});
    getEditSteps().then((v) => setRows(v.steps.filter((s) => s.state === "on")), () => {});
    listSkills().then(
      (r) =>
        setSkills([
          ...(r.skills ?? []).filter((s) => s.on && !s.projectIds?.length && (placeOf(s) === "editor.script" || s.id === style?.skill)),
          ...(r.shared ?? []).filter((s) => s.place === "editor.script"),
        ]),
      () => {},
    );
    if (style) listFinished(style.id).then((list) => setFinished(Array.isArray(list) ? list : []), () => {});
  }, [style]);

  const grades = defaults?.items.grade ?? [];
  const gradeShown = grade ?? (grades.some((g) => g.id === style?.grade) ? style!.grade! : (defaults?.bundle.grade ?? ""));
  const folderShown = folders.some((f) => f.id === folder) ? folder : "";
  const animationShown = animations.some((a) => a.id === animation) ? animation : "";
  const skillShown = skill ?? (skills.some((s) => s.id === style?.skill) ? style!.skill! : "");
  // the steps as an edit made now would get them: this style's, else the ones in use in Settings → AI Editor
  const stepsShown = steps ?? style?.steps ?? rows.filter((r) => r.use).map((r) => ({ id: r.id, values: r.values }));
  const setStep = (row: StepRow, on: boolean, values?: Record<string, string>) => {
    const rest = stepsShown.filter((s) => s.id !== row.id);
    const was = stepsShown.find((s) => s.id === row.id);
    setSteps(on ? [...rest, { id: row.id, values: { ...row.values, ...was?.values, ...values } }] : rest);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const body: EditingStyleInput = {
      name,
      notes,
      versions,
      targetS: Number(targetS) || 0,
      pace,
      punch,
      size: sizeOfKey(size),
      ...(passes !== !!style?.passes ? { passes } : {}),   // sent only when changed here
      ...(folders.length ? { brollCollectionId: folderShown || null } : {}),
      ...(animations.length ? { animation: animationShown || null } : {}),   // none of their own: nothing is said about one
      ...(skill !== null ? { skill: skill || null } : {}),
      ...(grade !== null ? { grade } : {}),
      ...(steps ? { steps } : {}),
      // sent only when changed here: the person's own from then on (the route marks it), or taken off
      ...(style?.playbook && playbook !== style.playbook.text ? { playbook: playbook?.trim() ? { ...style.playbook, text: playbook } : null } : {}),
    };
    try {
      await onSaved(await (style ? updateStyle(style.id, body) : proposal ? keepProposal(proposal.id, { ...body, animationBrief: keepCards ? cards : null }) : createStyle(body)));
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" aria-describedby={undefined} className="w-full overflow-y-scroll p-0 sm:max-w-xl">
        <fieldset disabled={!editable} className="contents">
        <form
          className="flex flex-col gap-4 p-4 pt-12"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <SheetTitle className="text-base">{style ? "Editing style" : proposal ? "Suggested style" : "New editing style"}</SheetTitle>
          {proposal && (
            <section aria-label="Read from the reference" className="flex flex-col gap-2 rounded-xl border border-zinc-500/20 p-3 text-sm">
              <span className="text-xs text-zinc-500">{proposal.fromLabel}</span>
              <p>{proposal.seen}</p>
              {proposal.animation && (
                <>
                  <div className="flex gap-1.5 overflow-x-auto">
                    {Array.from({ length: proposal.animation.stills }, (_, n) => (
                      <img key={n} src={proposalStillUrl(proposal.id, n)} alt="" className="h-20 shrink-0 rounded border border-zinc-500/20" />
                    ))}
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="style-cards-on">Cards look</Label>
                    <Switch id="style-cards-on" checked={keepCards} onCheckedChange={setKeepCards} />
                  </div>
                  {keepCards && <Textarea aria-label="Cards look" value={cards} onChange={(e) => setCards(e.target.value)} rows={3} maxLength={ANIMATION_BRIEF_MAX} />}
                </>
              )}
            </section>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="style-name">Name</Label>
            <Input id="style-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={STYLE_NAME_MAX} autoFocus={!style} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="style-notes">Describe the editing style</Label>
            <Textarea id="style-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={6} maxLength={STYLE_NOTES_MAX} />
          </div>
          {style?.playbook && playbook !== null && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="style-playbook">Researched</Label>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-zinc-500" onClick={() => setPlaybook(null)}>
                  Delete
                </Button>
              </div>
              <Textarea id="style-playbook" value={playbook} onChange={(e) => setPlaybook(e.target.value)} rows={8} maxLength={PLAYBOOK_MAX} />
              {style.playbook.sources.length > 0 && (
                <ul className="flex flex-col gap-0.5 text-xs">
                  {style.playbook.sources.map((src, i) => (
                    <li key={i} className="truncate">
                      <a href={src.url} target="_blank" rel="noreferrer" className="text-zinc-500 underline">
                        {src.title || src.url}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="style-versions">Versions</Label>
              <select id="style-versions" value={versions} onChange={(e) => setVersions(Number(e.target.value))} className={`${select} w-24`}>
                {Array.from({ length: MAX_VERSIONS }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="style-target">Length (seconds)</Label>
              <Input id="style-target" type="number" min={0} max={3600} value={targetS} onChange={(e) => setTargetS(e.target.value)} placeholder="Any" className="w-28" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="style-pace">Pace</Label>
              <select id="style-pace" value={pace} onChange={(e) => setPace(e.target.value as Pace)} className={`${select} min-w-28`}>
                {PACES.map((p) => (
                  <option key={p} value={p}>
                    {PACE_OPTION[p]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="style-punch">Zoom on cuts</Label>
              <select id="style-punch" value={punch} onChange={(e) => setPunch(Number(e.target.value))} className={`${select} w-28`}>
                {PUNCHES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="style-size">Video size</Label>
              <select id="style-size" value={size} onChange={(e) => setSize(e.target.value)} className={`${select} min-w-40`}>
                {SIZE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-wrap gap-4">
              {/* a suggestion's cards look, kept, is the animation style it gets */}
              {!(proposal && keepCards) && <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="style-animation">Animation style</Label>
                <select id="style-animation" value={animationShown} onChange={(e) => (e.target.value === NEW_ANIMATION ? setMakingAnimation(true) : setAnimation(e.target.value))} className={`${select} min-w-40 max-w-full`}>
                  <option value="">None</option>
                  {animations.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                  <option value={NEW_ANIMATION}>New animation style…</option>
                </select>
              </div>}
              {grades.length > 1 && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="style-grade">Grade</Label>
                  <select id="style-grade" value={gradeShown} onChange={(e) => setGrade(e.target.value)} className={`${select} min-w-40`}>
                    {grades.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.from ? `${g.title} (${g.from})` : g.title}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {folders.length > 0 && (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor="style-broll">B-roll folder</Label>
                  <select id="style-broll" value={folderShown} onChange={(e) => setFolder(e.target.value)} className={`${select} min-w-40 max-w-full`}>
                    <option value="">None</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {skills.length > 0 && (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor="style-skill">Skill</Label>
                  <select id="style-skill" value={skillShown} onChange={(e) => setSkill(e.target.value)} className={`${select} min-w-40 max-w-full`}>
                    <option value="">None</option>
                    {skills.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
          </div>
          {rows.length > 0 && (
            <section aria-label="Post-processing" className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Post-processing</h3>
              <ul className="flex flex-col divide-y divide-zinc-500/15 rounded-xl border border-zinc-500/20">
                {rows.map((row) => {
                  const mine = stepsShown.find((s) => s.id === row.id);
                  return (
                    <li key={row.id} className="flex flex-col gap-2 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm">{row.title}</span>
                        <Switch checked={!!mine} aria-label={`${row.title} in this style`} onCheckedChange={(on) => setStep(row, on)} />
                      </div>
                      {mine &&
                        (row.options ?? []).map((o) => (
                          <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                            <Label htmlFor={`style-step-${row.id}-${o.id}`} className="font-normal text-zinc-500">
                              {o.label}
                            </Label>
                            {o.kind === "choice" ? (
                              <select id={`style-step-${row.id}-${o.id}`} value={mine.values[o.id] ?? o.default} onChange={(e) => setStep(row, true, { [o.id]: e.target.value })} className={`${select} min-w-36`}>
                                {(o.choices ?? []).map((c) => (
                                  <option key={c.value} value={c.value}>
                                    {c.label}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <Input
                                id={`style-step-${row.id}-${o.id}`}
                                value={mine.values[o.id] ?? o.default}
                                onChange={(e) => setStep(row, true, { [o.id]: e.target.value })}
                                placeholder={o.placeholder}
                                maxLength={2000}
                                className="w-full sm:w-64"
                              />
                            )}
                          </div>
                        ))}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="style-passes">Edit in passes</Label>
              <span className="text-xs text-muted-foreground">Each pass goes to Review before the next</span>
            </div>
            <Switch id="style-passes" checked={passes} onCheckedChange={setPasses} />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
{editable &&           <Button type="submit" disabled={busy || !name.trim()} className="self-start">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {proposal ? "Keep style" : "Save"}
          </Button>}
          {style && finished.length > 0 && (
            <section aria-label="Finished with this style" className="flex flex-col gap-2 pt-2">
              <h3 className="text-sm font-medium">Finished with this style</h3>
              <ul className="flex flex-col divide-y divide-zinc-500/15 rounded-xl border border-zinc-500/20">
                {finished.map((f) => {
                  const day = new Date(f.at).toLocaleDateString();
                  return (
                    <li key={f.editId} className="flex items-center justify-between gap-3 py-1.5 pl-3 pr-1.5">
                      <span className="min-w-0 truncate text-sm">{f.name || day}</span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-zinc-500">
                        {[f.seconds ? `${f.seconds} s` : "", f.name ? day : ""].filter(Boolean).join(" · ")}
{editable &&                         <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={`Remove ${f.name || day} from the finished edits`}
                          onClick={() => void removeFinished(style.id, f.editId).then(() => setFinished((list) => list.filter((x) => x.editId !== f.editId)), (e) => setError(message(e)))}
                        >
                          <X className="h-4 w-4" />
                        </Button>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {style && learned.length > 0 && (
            <section aria-label="From finished edits" className="flex flex-col gap-2 pt-2">
              <h3 className="text-sm font-medium">From finished edits</h3>
              <p className="text-xs text-zinc-500">Rounds to approval: {learned.slice(0, 5).map((l) => l.rounds).join(" · ")}</p>
              <ul className="flex flex-col divide-y divide-zinc-500/15 rounded-xl border border-zinc-500/20">
                {learned.map((l) => {
                  const day = new Date(l.at).toLocaleDateString();
                  return (
                    <li key={l.editId} className="flex items-start justify-between gap-3 py-1.5 pl-3 pr-1.5">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-xs text-zinc-500">{[day, l.cut.shots ? cutLine(l.cut) : ""].filter(Boolean).join(" · ")}</span>
                        {l.notes.map((n, i) => (
                          <span key={i} className="whitespace-pre-line text-sm">
                            {n}
                          </span>
                        ))}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        aria-label={`Remove the notes from the edit of ${day}`}
                        onClick={() =>
                          void removeLearned(style.id, l.editId).then(() => {
                            const next = learned.filter((x) => x.editId !== l.editId);
                            setLearned(next);
                            void onSaved({ ...style, learned: next });
                          }, (e) => setError(message(e)))
                        }
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </form>
        </fieldset>
        {makingAnimation && (
          <AnimationSheet
            style={null}
            onClose={() => setMakingAnimation(false)}
            onSaved={async (made) => {
              setAnimations((await listAnimationStyles()).styles ?? []);
              setAnimation(made.id);
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
