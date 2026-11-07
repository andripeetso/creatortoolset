import { useWorkspace } from "@/lib/workspace";
import { Notice } from "./ui";
import { packContents } from "./packs-helpers";
import { selectCls } from "./helpers";

type Contents = Parameters<typeof packContents>[0];

/** The full list of what a pack adds: instruction text per slot (with its label), frameworks and caption styles. */
export function ContentsView({ pack }: { pack: Contents }) {
  const c = packContents(pack);
  if (!c.slots.length && !c.frameworks.length && !c.captionStyles.length) return <p className="text-xs text-muted-foreground">Nothing this app uses.</p>;
  return (
    <div className="space-y-3 text-sm">
      {c.slots.map((s) => (
        <div key={s.slot}>
          <div className="text-xs font-medium text-foreground">Instructions: {s.label}</div>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-sans text-xs text-muted-foreground">{s.text}</pre>
        </div>
      ))}
      {c.frameworks.length > 0 && <ListLine label={`Frameworks (${c.frameworks.length})`} items={c.frameworks.map((f) => `${f.name} (${f.role})`)} />}
      {c.captionStyles.length > 0 && <ListLine label={`Caption styles (${c.captionStyles.length})`} items={c.captionStyles} />}
    </div>
  );
}

function ListLine({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div className="text-xs font-medium text-foreground">{label}</div>
      <p className="mt-0.5 text-xs text-muted-foreground">{items.join(", ")}</p>
    </div>
  );
}

/** One line: what the pack adds, by count. */
export function ContentsSummary({ pack }: { pack: Contents }) {
  const c = packContents(pack);
  const parts = [
    c.slots.length ? `instructions for ${c.slots.length} ${c.slots.length === 1 ? "place" : "places"}` : "",
    c.frameworks.length ? `${c.frameworks.length} ${c.frameworks.length === 1 ? "framework" : "frameworks"}` : "",
    c.captionStyles.length ? `${c.captionStyles.length} caption ${c.captionStyles.length === 1 ? "style" : "styles"}` : "",
  ].filter(Boolean);
  return <span>{parts.length ? parts.join(", ") : "nothing"}</span>;
}

/** Where an install goes: every project, or only the current one. */
export function ScopeSelect({ value, onChange, disabled }: { value: "all" | "project"; onChange: (v: "all" | "project") => void; disabled?: boolean }) {
  const currentProjectId = useWorkspace((s) => s.currentProjectId);
  const projects = useWorkspace((s) => s.projects);
  const name = projects.find((p) => p.id === currentProjectId)?.name;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as "all" | "project")} disabled={disabled} className={selectCls} aria-label="Install for">
      <option value="all">All my projects</option>
      {currentProjectId && <option value="project">Only {name ?? "this project"}</option>}
    </select>
  );
}

/** The warning above every install: nobody reviewed the file. */
export function UnreviewedNote() {
  return <Notice tone="warn">Not reviewed: only install packs from people you trust. A pack can change what the AI is told to write.</Notice>;
}
