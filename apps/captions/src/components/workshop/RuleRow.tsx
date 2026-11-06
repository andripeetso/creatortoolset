import { useState } from "react";
import { Loader2, Pencil } from "lucide-react";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import type { RuleFields, WorkshopRule } from "@/lib/workshop";

const input =
  "w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500";

/** One writing rule: on/off by default, editable text, delete. */
export function RuleRow({
  rule,
  busy,
  onSave,
  onDelete,
}: {
  rule: WorkshopRule;
  busy: boolean;
  onSave: (fields: Partial<RuleFields>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(rule.name);
  const [text, setText] = useState(rule.text);
  return (
    <div className={`flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 ${rule.on ? "" : "opacity-60"}`}>
      <input
        type="checkbox"
        checked={rule.on}
        disabled={busy}
        onChange={(e) => onSave({ on: e.target.checked })}
        title={rule.on ? "On for every generation" : "Off unless switched on for a run"}
        className="mt-1 accent-violet-500"
      />
      {editing ? (
        <form
          className="flex min-w-0 flex-1 flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onSave({ name, text });
            setEditing(false);
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Short name" className={input} />
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="The rule, as an instruction to the writer" className={input} />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} className="rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800">
              Cancel
            </button>
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
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-zinc-400">{rule.text}</p>
        </div>
      )}
      {!editing && (
        <button type="button" onClick={() => setEditing(true)} disabled={busy} className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
          <Pencil className="h-3 w-3" /> Edit
        </button>
      )}
      <ConfirmButton
        label="Delete"
        confirmLabel="Click again"
        disabled={busy}
        onConfirm={onDelete}
        className="rounded-md px-2 py-1.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-red-300 disabled:opacity-50"
        armedClassName="!bg-red-500/10 !text-red-200"
      />
    </div>
  );
}
