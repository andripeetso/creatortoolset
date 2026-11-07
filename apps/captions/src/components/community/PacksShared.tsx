import { packContents } from "./packs-helpers";

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

export function OfficialBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-violet-500/15 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300">
      Official
    </span>
  );
}
