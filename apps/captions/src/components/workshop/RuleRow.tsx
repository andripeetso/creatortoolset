import { useState } from "react";
import { Loader2, Pencil } from "lucide-react";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import type { RuleFields, ScopeInput, WorkshopRule } from "@/lib/workshop";
import { ScopeTags, WorkspacesField, useScope } from "./RuleWorkspaces";

const input =
  "w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500";

/** One writing rule: on/off by default, editable text and workspaces, a version for this workspace, delete. */
export function RuleRow({
  rule,
  busy,
  onSave,
  onDelete,
  onUseShared,
  readOnly,
}: {
  rule: WorkshopRule;
  busy: boolean;
  onSave: (fields: Partial<RuleFields> & ScopeInput) => void;
  onDelete: () => void;
  /** Deletes this workspace's own version: the shared rule is used here again. */
  onUseShared: () => void;
  /** Shows the rule only: no switch, Edit or Delete. */
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(rule.name);
  const [text, setText] = useState(rule.text);
  const scope = useScope(rule);
  const edit = () => {
    setName(rule.name);
    setText(rule.text);
    scope.setOnly(rule.only);
    setEditing(true);
  };
  const small = "rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800";
  return (
    <div className={`flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 ${rule.on ? "" : "opacity-60"}`}>
      {readOnly ? null : <input
        type="checkbox"
        checked={rule.on}
        disabled={busy}
        onChange={(e) => onSave({ on: e.target.checked })}
        title={rule.on ? "On for every piece" : "Off unless turned on for a piece"}
        className="mt-1 accent-violet-500"
      />}
      {editing ? (
        <form
          className="flex min-w-0 flex-1 flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onSave({ name, text, ...scope.saved() });
            setEditing(false);
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={input} />
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Rule" className={input} />
          {/* this workspace's version applies here only: where the shared one applies is changed from it */}
          {!rule.changedHere && <WorkspacesField only={scope.only} onChange={scope.setOnly} />}
          <div className="flex flex-wrap justify-end gap-2">
            {rule.changedHere && (
              <button type="button" disabled={busy} onClick={() => (onUseShared(), setEditing(false))} className={`${small} mr-auto`}>
                Use shared version
              </button>
            )}
            <button type="button" onClick={() => setEditing(false)} className={small}>
              Cancel
            </button>
            {scope.versionFor && (
              <button type="button" disabled={busy || !text.trim()} onClick={() => (onSave({ name, text, here: true }), setEditing(false))} className="rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
                Save for {scope.versionFor.name}
              </button>
            )}
            <button type="submit" disabled={busy || !text.trim()} className="flex items-center gap-1 rounded-md bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50">
              {busy && <Loader2 className="h-3 w-3 animate-spin" />} Save
            </button>
          </div>
        </form>
      ) : (
        <div className="min-w-0 flex-1">
          <p className="text-sm text-zinc-100">
            {rule.name}
            {rule.seedKey ? <span className="ml-2 text-[10px] text-zinc-600">starter</span> : null}
            <ScopeTags item={rule} />
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-zinc-400">{rule.text}</p>
        </div>
      )}
      {!editing && !readOnly && (
        <button type="button" onClick={edit} disabled={busy} className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
          <Pencil className="h-3 w-3" /> Edit
        </button>
      )}
      {!readOnly && (
        <ConfirmButton
          label="Delete"
          confirmLabel="Click again"
          disabled={busy}
          onConfirm={onDelete}
          className="rounded-md px-2 py-1.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-red-300 disabled:opacity-50"
          armedClassName="!bg-red-500/10 !text-red-200"
        />
      )}
    </div>
  );
}
