import { useState } from "react";
import { X } from "lucide-react";
import { TAG_KINDS, type Tag, type TagKind } from "@/lib/instagram";

const KIND_CLASS: Record<TagKind, string> = {
  format: "border-sky-800/80 bg-sky-950/40 text-sky-200",
  topic: "border-zinc-800 bg-zinc-900/70 text-zinc-300",
  hook: "border-zinc-800 bg-zinc-900/70 text-zinc-300",
  cta: "border-zinc-800 bg-zinc-900/70 text-zinc-300",
  audience: "border-zinc-800 bg-zinc-900/70 text-zinc-300",
  custom: "border-zinc-800 bg-zinc-900/70 text-zinc-300",
};

const KIND_IDS = new Set(TAG_KINDS.map((k) => k.id));

function parseDraft(raw: string, fallback: TagKind): { label: string; kind: TagKind } {
  const text = raw.trim().replace(/^#/, "");
  const m = text.match(/^(topic|format|hook|cta|audience):\s*(.+)$/i);
  if (m) {
    const kind = m[1].toLowerCase() as TagKind;
    return { label: m[2].trim().slice(0, 40), kind: KIND_IDS.has(kind) ? kind : fallback };
  }
  return { label: text.slice(0, 40), kind: fallback };
}

export function TagsEditor({
  tags,
  onChange,
  onFilter,
  disabled,
  defaultKind = "custom",
}: {
  tags: Tag[] | undefined;
  onChange?: (tags: Tag[]) => void;
  onFilter?: (label: string) => void;
  disabled?: boolean;
  defaultKind?: TagKind;
}) {
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<TagKind>(defaultKind);
  const list = tags ?? [];
  const add = () => {
    const parsed = parseDraft(draft, kind);
    if (parsed.label.length < 2 || !onChange) return;
    if (list.some((t) => t.label.toLowerCase() === parsed.label.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([
      ...list,
      {
        id: `t_${Math.random().toString(36).slice(2, 10)}`,
        label: parsed.label,
        kind: parsed.kind,
        source: "user",
      },
    ]);
    setDraft("");
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {list.length === 0 && <span className="text-[11px] text-zinc-600">No tags yet.</span>}
        {list.map((t) => (
          <span
            key={t.id}
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${KIND_CLASS[t.kind]}`}
          >
            <button
              type="button"
              onClick={() => onFilter?.(t.label)}
              className="hover:text-violet-200"
              title={`${t.kind} · ${t.source}`}
            >
              {t.kind !== "custom" ? `${t.kind}:` : ""}
              {t.label}
            </button>
            {onChange && !disabled && (
              <button
                type="button"
                onClick={() => onChange(list.filter((x) => x.id !== t.id))}
                className="text-zinc-600 hover:text-zinc-300"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
      </div>
      {onChange && !disabled && (
        <div className="mt-2 flex gap-1.5">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as TagKind)}
            className="rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-400"
            title="What kind of tag"
          >
            {TAG_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder={kind === "format" ? "Name the format" : "Add a tag"}
            className="min-w-0 flex-1 rounded-md border border-zinc-800 bg-transparent px-2 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-violet-500"
          />
        </div>
      )}
    </div>
  );
}
