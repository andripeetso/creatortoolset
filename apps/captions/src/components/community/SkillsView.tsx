import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Globe, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  SKILL_LIMITS,
  SKILL_PLACES,
  checkSkill,
  everyProject,
  opensByLine,
  parseSkillFile,
  pickSkillFile,
  pickedByStyle,
  placeLabel,
  placeOf,
  type SharedSkill,
  type Skill,
  type SkillDraft,
  type SkillPlace,
} from "@contracts/skills";
import { isPackSkillSlot } from "@contracts/packs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useCachedLoad } from "@/lib/local-cache";
import { addSkill, droppedSkillFile, listSkills, removeSkill, setSharedOn, updateSkill } from "@/lib/skills";
import { cn } from "@/lib/utils";
import { Card, ErrorRow, FormDialog, ListRow, LoadingRow, RowMenu, Section, saveFailed } from "@/components/settings/ui";
import { msg } from "@/components/settings/helpers";
import { ProjectsPicker } from "./ProjectsPicker";
import { PublishDialog } from "./PublishDialog";

/**
 * Community → Skills: every skill, one section per place it acts, headed with the tool's own words. Each place lists
 * the person's own (switch, projects, edit, publish, remove), then the ones their packs and the server's plug-ins bring
 * (a source line and a switch). An AI Editor script skill has no switch: an editing style picks it. A tool's page in
 * Settings → Tools shows only its own places (`places`), each headed by `title`.
 */
export function SkillsView({ places = SKILL_PLACES, title = placeLabel }: { places?: readonly SkillPlace[]; title?: (p: SkillPlace) => string } = {}) {
  // own: this window's saves read the list again too, and a pack installed here brings its skills
  const data = useCachedLoad<{ skills: Skill[]; shared?: SharedSkill[] }>("/api/skills", listSkills, { topic: ["skills", "packs"], own: true });
  const [editing, setEditing] = useState<{ place: SkillPlace; skill?: Skill } | null>(null);
  const [publishing, setPublishing] = useState<Skill | null>(null);
  const reload = () => data.refresh().catch(() => {});
  if (!data.data)
    return <Card>{data.error ? <ErrorRow title="Your skills did not load" detail={data.error} retry={() => void reload()} /> : <LoadingRow />}</Card>;
  const own = data.data.skills;
  const shared = data.data.shared ?? [];
  return (
    <>
      {places.map((place) => {
        const mine = own.filter((s) => placeOf(s) === place);
        const theirs = shared.filter((s) => s.place === place);
        return (
          <Section
            key={place}
            title={title(place)}
            action={
              <Button size="xs" variant="ghost" onClick={() => setEditing({ place })} aria-label={`Add a skill for ${placeLabel(place)}`}>
                <Plus className="size-3" /> Add
              </Button>
            }
          >
            {(mine.length > 0 || theirs.length > 0) && (
              <Card>
                {mine.map((s) => (
                  <OwnRow key={s.id} skill={s} onEdit={() => setEditing({ place, skill: s })} onPublish={() => setPublishing(s)} onChanged={reload} />
                ))}
                {theirs.map((s) => (
                  <SharedRow key={s.id} skill={s} onChanged={reload} />
                ))}
              </Card>
            )}
          </Section>
        );
      })}
      {editing && (
        <SkillDialog
          key={editing.skill?.id ?? editing.place}
          place={editing.place}
          initial={editing.skill ?? null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      {publishing && <PublishDialog item={{ kind: "skill", id: publishing.id, defaultName: publishing.name }} onClose={() => setPublishing(null)} />}
    </>
  );
}

function OwnRow({ skill: s, onEdit, onPublish, onChanged }: { skill: Skill; onEdit: () => void; onPublish: () => void; onChanged: () => Promise<void> }) {
  const place = placeOf(s);
  const save = (patch: Parameters<typeof updateSkill>[1]) => updateSkill(s.id, patch).then(onChanged).catch((e) => saveFailed(msg(e)));
  return (
    <ListRow
      title={s.name}
      subtitle={s.when || undefined}
      // under the text, not beside it: on a phone the row's right end has room for the switch and the menu only
      status={everyProject(place) ? undefined : <ProjectsPicker value={s.projectIds ?? []} onChange={(ids) => void save({ projectIds: ids.length ? ids : null })} />}
      actions={
        <>
          {!pickedByStyle(place) && <Switch checked={s.on} onCheckedChange={(on) => void save({ on })} aria-label={`Turn ${s.name} on or off`} />}
          <RowMenu
            label={`Actions for ${s.name}`}
            items={[
              { label: "Edit", icon: <Pencil />, onSelect: onEdit },
              ...(isPackSkillSlot(place) ? [{ label: "Publish to Community", icon: <Globe />, onSelect: onPublish }] : []),
              {
                label: "Remove",
                icon: <Trash2 />,
                destructive: true,
                confirm: { title: `Remove "${s.name}"?` },
                onSelect: () => removeSkill(s.id).then(onChanged),
              },
            ]}
          />
        </>
      }
    />
  );
}

function SharedRow({ skill: s, onChanged }: { skill: SharedSkill; onChanged: () => Promise<void> }) {
  return (
    <ListRow
      title={s.name}
      subtitle={`${s.source === "community" ? "Community" : "Plug-in"}: ${s.from}`}
      actions={
        pickedByStyle(s.place) ? undefined : (
          <Switch checked={s.on} onCheckedChange={(on) => void setSharedOn(s.id, on).then(onChanged).catch((e) => saveFailed(msg(e)))} aria-label={`Turn ${s.name} on or off`} />
        )
      }
    />
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-xs font-medium text-foreground">{label}</div>
      {children}
    </div>
  );
}

/** Add or edit one skill of a place. A dropped or chosen file fills the fields; what is saved is what the fields show. */
function SkillDialog({ place, initial, onClose, onSaved }: { place: SkillPlace; initial: Skill | null; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<SkillDraft>(() => ({ name: initial?.name ?? "", when: initial?.when ?? "", body: initial?.body ?? "" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const byLine = opensByLine(place);
  const set = (patch: Partial<SkillDraft>) => {
    setError(null);
    setD((cur) => ({ ...cur, ...patch }));
  };

  /** Only the file's text is read: its name, the line that says when to use it, and its body (parseSkillFile). */
  const take = async (file: File | null) => {
    if (!file) return setError("No skill file there: drop a text file, or a folder with a SKILL.md in it.");
    if (file.size > SKILL_LIMITS.file * 4) return setError("That file is too long to be a skill.");
    const read = parseSkillFile(await file.text(), file.name);
    if ("error" in read) return setError(read.error);
    setError(null);
    setD((cur) => ({ name: read.name || cur.name, when: read.when || cur.when, body: read.body }));
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    void droppedSkillFile(e.dataTransfer, pickSkillFile).then(take, () => setError("That could not be read."));
  };

  const submit = async () => {
    const checked = checkSkill(d, place);
    if ("error" in checked) return setError(checked.error);
    setBusy(true);
    try {
      if (initial) await updateSkill(initial.id, checked.skill);
      else if (!(await addSkill({ ...checked.skill, place })).on) toast(`Saved switched off: ${SKILL_LIMITS.perTurn} skills are on here already.`);
      onSaved();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog open onOpenChange={(open) => !open && onClose()} title={placeLabel(place)} submitLabel={initial ? "Save" : "Add skill"} onSubmit={submit} busy={busy} error={error} wide>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cn("space-y-3 rounded-lg", over && "outline-dashed outline-2 outline-offset-4 outline-ring")}
      >
        <Field label="Name">
          <Input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Hook rules" maxLength={SKILL_LIMITS.name} aria-label="Name" className="h-8" />
        </Field>
        {byLine && (
          <Field label="When to use it">
            <Input value={d.when} onChange={(e) => set({ when: e.target.value })} placeholder="e.g. When writing the first line of a reel" maxLength={SKILL_LIMITS.when} aria-label="When to use it" className="h-8" />
          </Field>
        )}
        <Field label="Skill">
          <Textarea value={d.body} onChange={(e) => set({ body: e.target.value })} rows={12} aria-label="Skill" className="font-mono text-xs" />
        </Field>
        <input
          ref={picker}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          hidden
          onChange={(e) => {
            void take(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />
        <Button type="button" size="sm" variant="outline" onClick={() => picker.current?.click()}>
          Choose a file
        </Button>
      </div>
    </FormDialog>
  );
}
