import { useState } from "react";
import { Loader2 } from "lucide-react";
import { FRAMEWORK_ROLES, type FrameworkRole, type WorkshopFramework } from "@/lib/workshop";

export interface FrameworkDraft {
  name: string;
  role: FrameworkRole;
  summary: string;
  steps: string;
  whenToUse: string;
  pairsWith: string;
  example: string;
}

const EMPTY: FrameworkDraft = { name: "", role: "narrative", summary: "", steps: "", whenToUse: "", pairsWith: "", example: "" };

const input =
  "w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500";

/** A storytelling framework: its role in a piece, the beats it walks through, when it fits, what it pairs with. */
export function FrameworkForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial?: WorkshopFramework;
  busy: boolean;
  onSave: (fields: FrameworkDraft) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<FrameworkDraft>(
    initial
      ? {
          name: initial.name,
          role: initial.role ?? "narrative",
          summary: initial.summary,
          steps: initial.steps.join("\n"),
          whenToUse: initial.whenToUse,
          pairsWith: initial.pairsWith ?? "",
          example: initial.example ?? "",
        }
      : EMPTY,
  );
  const set = (k: keyof FrameworkDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }));
  const stepCount = f.steps.split("\n").filter((s) => s.trim()).length;
  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(f);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="text-[11px] text-zinc-400">
          Name
          <input autoFocus value={f.name} onChange={set("name")} placeholder="Myth – Truth – Proof" className={`${input} mt-1`} />
        </label>
        <label className="text-[11px] text-zinc-400">
          Role
          <select value={f.role} onChange={set("role")} className={`${input} mt-1`}>
            {FRAMEWORK_ROLES.map((r) => (
              <option key={r.id} value={r.id} title={r.hint}>
                {r.label} — {r.hint}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="text-[11px] text-zinc-400">
        How it works (one line)
        <textarea value={f.summary} onChange={set("summary")} rows={2} placeholder="Take a belief the audience holds, overturn it, back the new view with evidence." className={`${input} mt-1`} />
      </label>
      <label className="text-[11px] text-zinc-400">
        Steps, one per line ({stepCount})
        <textarea value={f.steps} onChange={set("steps")} rows={6} placeholder={"State the common belief\nWhy it is wrong\nWhat is actually true\nProof\nWhat to do instead"} className={`${input} mt-1 font-mono text-[13px]`} />
      </label>
      <label className="text-[11px] text-zinc-400">
        Works best for
        <textarea value={f.whenToUse} onChange={set("whenToUse")} rows={2} placeholder="Contrarian and educational angles; comment-heavy topics." className={`${input} mt-1`} />
      </label>
      <label className="text-[11px] text-zinc-400">
        Pairs with
        <input value={f.pairsWith} onChange={set("pairsWith")} placeholder="Backwards Reveal, I Was Wrong" className={`${input} mt-1`} />
      </label>
      <label className="text-[11px] text-zinc-400">
        Example (optional)
        <textarea value={f.example} onChange={set("example")} rows={2} className={`${input} mt-1`} />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || f.name.trim().length === 0 || stepCount < 2}
          className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {initial ? "Save" : "Create framework"}
        </button>
      </div>
    </form>
  );
}
