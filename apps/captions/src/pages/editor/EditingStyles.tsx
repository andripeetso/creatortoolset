import { useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { MAX_VERSIONS, type EditorDefaults } from "@contracts/editor";
import type { EditStepChoice, StepRow } from "@contracts/editor-steps";
import { PACES, PACE_NAME, PUNCHES, STYLE_NAME_MAX, STYLE_NOTES_MAX, WORKING_SIZES, type AnimationStyle, type EditingStyle, type EditingStyleInput, type FinishedEdit, type Pace, type WorkingSize } from "@contracts/editor-styles";
import { placeOf } from "@contracts/skills";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { RowMenu } from "@/components/settings/ui";
import { createStyle, deleteStyle, getEditorDefaults, getEditSteps, listAnimationStyles, listFinished, removeFinished, updateStyle } from "@/lib/editor";
import { listCollections, listLibraries } from "@/lib/library";
import { listSkills } from "@/lib/skills";

/**
 * The AI Editor's Editing styles tab: the person's styles as cards, and the sheet one is made and changed in. A style
 * is the choices of New edit under a name, with notes in their own words; New edit picks one (pages/EditorPage.tsx) and
 * an edit keeps its own copy. `open` is the style in the sheet, "new" for a new one; the page owns it, so its own
 * "New editing style" button opens the same sheet.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const select = "h-9 rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm";

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

export function EditingStyles({ styles, open, onOpen, onChanged }: { styles: EditingStyle[]; open: OpenStyle; onOpen: (s: OpenStyle) => void; onChanged: () => Promise<unknown> }) {
  return (
    <>
      {styles.length === 0 ? (
        <div className="flex justify-center py-16">
          <Button size="sm" onClick={() => onOpen("new")}>
            <Plus className="h-4 w-4" />
            New editing style
          </Button>
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
                <span className="w-full truncate pr-8 text-sm font-medium">{s.name}</span>
                <span className="text-xs text-zinc-500">{styleLine(s)}</span>
                {s.notes && <span className="line-clamp-2 whitespace-pre-line text-xs text-zinc-500">{s.notes}</span>}
              </button>
              <div className="absolute right-2 top-2.5">
                <RowMenu
                  label={`More for ${s.name}`}
                  items={[
                    { label: "Duplicate", onSelect: () => duplicateStyle(s).then(onChanged) },
                    { label: "Delete", destructive: true, confirm: { title: `Delete “${s.name}”?` }, onSelect: () => deleteStyle(s.id).then(onChanged) },
                  ]}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {open && <StyleSheet key={open === "new" ? "new" : open.id} style={open === "new" ? null : open} onClose={() => onOpen(null)} onSaved={onChanged} />}
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
 * taken off; the skill is sent only when changed here, so one the style names that is switched off for now is kept. Under Save, the edits finished with the style, each with an × that takes it off for good.
 */
function StyleSheet({ style, onClose, onSaved }: { style: EditingStyle | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [name, setName] = useState(style?.name ?? "");
  const [notes, setNotes] = useState(style?.notes ?? "");
  const [versions, setVersions] = useState(style?.versions ?? 1);
  const [targetS, setTargetS] = useState(style?.targetS ? String(style.targetS) : "");
  const [pace, setPace] = useState<Pace>(style?.pace ?? "tight");
  const [punch, setPunch] = useState(style?.punch ?? 1.15);
  const [size, setSize] = useState(style ? sizeKey(style.size) : NEW_SIZE);
  const [folder, setFolder] = useState(style?.brollCollectionId ?? "");
  const [animation, setAnimation] = useState(style?.animation ?? "");
  const [passes, setPasses] = useState(!!style?.passes);
  const [animations, setAnimations] = useState<AnimationStyle[]>([]);
  const [grade, setGrade] = useState<string | null>(null); // null: not changed here
  const [steps, setSteps] = useState<EditStepChoice[] | null>(null); // null: not changed here
  const [defaults, setDefaults] = useState<EditorDefaults | null>(null);
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<StepRow[]>([]);
  const [skill, setSkill] = useState<string | null>(null); // null: not changed here
  const [skills, setSkills] = useState<{ id: string; name: string }[]>([]);
  const [finished, setFinished] = useState<FinishedEdit[]>([]);
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
  // the steps as an edit made now would get them: this style's, else the ones in use in Settings → Tools → AI Editor
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
      ...(animations.length ? { animation: animationShown || null } : {}),
      ...(skill !== null ? { skill: skill || null } : {}),
      ...(grade !== null ? { grade } : {}),
      ...(steps ? { steps } : {}),
    };
    try {
      await (style ? updateStyle(style.id, body) : createStyle(body));
      await onSaved();
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" aria-describedby={undefined} className="w-full overflow-y-scroll p-0 sm:max-w-xl">
        <form
          className="flex flex-col gap-4 p-4 pt-12"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <SheetTitle className="text-base">{style ? "Editing style" : "New editing style"}</SheetTitle>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="style-name">Name</Label>
            <Input id="style-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={STYLE_NAME_MAX} autoFocus={!style} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="style-notes">How should it be cut?</Label>
            <Textarea id="style-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={6} maxLength={STYLE_NOTES_MAX} placeholder="Short lines, no intro. Keep the jokes. End on the question." />
          </div>
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
              <Label htmlFor="style-target">Target length (s)</Label>
              <Input id="style-target" type="number" min={0} max={3600} value={targetS} onChange={(e) => setTargetS(e.target.value)} placeholder="Any" className="w-28" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="style-pace">Pace</Label>
              <select id="style-pace" value={pace} onChange={(e) => setPace(e.target.value as Pace)} className={`${select} w-28`}>
                {PACES.map((p) => (
                  <option key={p} value={p}>
                    {PACE_NAME[p]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="style-punch">Punch-in</Label>
              <select id="style-punch" value={punch} onChange={(e) => setPunch(Number(e.target.value))} className={`${select} w-28`}>
                {PUNCHES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="style-size">Working size</Label>
              <select id="style-size" value={size} onChange={(e) => setSize(e.target.value)} className={`${select} min-w-40`}>
                {SIZE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {(grades.length > 1 || folders.length > 0 || animations.length > 0 || skills.length > 0) && (
            <div className="flex flex-wrap gap-4">
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
              {animations.length > 0 && (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor="style-animation">Animation style</Label>
                  <select id="style-animation" value={animationShown} onChange={(e) => setAnimation(e.target.value)} className={`${select} min-w-40 max-w-full`}>
                    <option value="">None</option>
                    {animations.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
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
          )}
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
              <span className="text-xs text-muted-foreground">Each pass waits for you in Review</span>
            </div>
            <Switch id="style-passes" checked={passes} onCheckedChange={setPasses} />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button type="submit" disabled={busy || !name.trim()} className="self-start">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
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
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={`Remove ${f.name || day} from the finished edits`}
                          onClick={() => void removeFinished(style.id, f.editId).then(() => setFinished((list) => list.filter((x) => x.editId !== f.editId)), (e) => setError(message(e)))}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </form>
      </SheetContent>
    </Sheet>
  );
}
