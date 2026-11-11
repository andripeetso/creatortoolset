import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { SKILL_LIMITS, checkSkill, parseSkillFile, pickSkillFile, type Skill, type SkillDraft } from "@contracts/skills";
import { ProjectsPicker } from "@/components/community/ProjectsPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useCachedLoad } from "@/lib/local-cache";
import { addSkill, droppedSkillFile, listSkills, removeSkill, updateSkill } from "@/lib/skills";
import { cn } from "@/lib/utils";
import { Card, ErrorRow, FormDialog, ListRow, LoadingRow, RowMenu, Section, saveFailed } from "./ui";
import { msg } from "./helpers";

/** This window's own saves read the list again too: the read after a save is never one that started before it. */
const OWN_TOO = { own: true };

/**
 * Settings → Skills: the person's own skills (contracts/skills.ts). Each is a name, the line that says when the AI
 * should use it, and the body: typed, pasted, or read from a dropped skill file. A row switches one off, ticks the
 * projects it is for, and opens it to edit or remove. With none, the page is its one Add button.
 */
export function SkillsSection() {
  const skills = useCachedLoad<{ skills: Skill[] }>("/api/skills", listSkills, OWN_TOO);
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const list = skills.data?.skills;
  const reload = () => skills.refresh().catch(() => {});

  return (
    <>
      <Section
        id="skills"
        title="Skills"
        action={
          <Button size="xs" variant="ghost" onClick={() => setEditing("new")}>
            <Plus className="size-3" /> Add skill
          </Button>
        }
      >
        {!list ? (
          <Card>{skills.error ? <ErrorRow title="Could not load your skills" detail={skills.error} retry={() => void reload()} /> : <LoadingRow title="Loading your skills…" />}</Card>
        ) : list.length > 0 ? (
          <Card>
            {list.map((s) => (
              <SkillRow key={s.id} skill={s} onEdit={() => setEditing(s)} onChanged={reload} />
            ))}
          </Card>
        ) : null}
      </Section>
      {editing && (
        <SkillDialog
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

function SkillRow({ skill: s, onEdit, onChanged }: { skill: Skill; onEdit: () => void; onChanged: () => Promise<void> }) {
  const save = (patch: Parameters<typeof updateSkill>[1]) => updateSkill(s.id, patch).then(onChanged).catch((e) => saveFailed(msg(e)));
  return (
    <ListRow
      title={s.name}
      subtitle={s.when}
      actions={
        <>
          <ProjectsPicker value={s.projectIds ?? []} onChange={(ids) => void save({ projectIds: ids.length ? ids : null })} />
          <Switch checked={s.on} onCheckedChange={(on) => void save({ on })} aria-label={`Turn ${s.name} on or off`} />
          <RowMenu
            label={`Actions for ${s.name}`}
            items={[
              { label: "Edit", icon: <Pencil />, onSelect: onEdit },
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-xs font-medium text-foreground">{label}</div>
      {children}
    </div>
  );
}

/** Add or edit one skill. A dropped or chosen file fills the three fields; what is saved is what the fields show. */
function SkillDialog({ initial, onClose, onSaved }: { initial: Skill | null; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<SkillDraft>(() => ({ name: initial?.name ?? "", when: initial?.when ?? "", body: initial?.body ?? "" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
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
    const checked = checkSkill(d);
    if ("error" in checked) return setError(checked.error);
    setBusy(true);
    try {
      if (initial) await updateSkill(initial.id, checked.skill);
      else if (!(await addSkill(checked.skill)).on) toast(`Saved switched off: ${SKILL_LIMITS.perTurn} skills are on already.`);
      onSaved();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog open onOpenChange={(open) => !open && onClose()} title={initial ? "Edit skill" : "Add skill"} submitLabel={initial ? "Save" : "Add skill"} onSubmit={submit} busy={busy} error={error} wide>
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
        <Field label="When to use it">
          <Input value={d.when} onChange={(e) => set({ when: e.target.value })} placeholder="e.g. When writing the first line of a reel" maxLength={SKILL_LIMITS.when} aria-label="When to use it" className="h-8" />
        </Field>
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
