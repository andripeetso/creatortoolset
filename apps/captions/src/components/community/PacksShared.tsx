import type { PackFramework } from "@contracts/packs";
import { Link } from "react-router";
import { containsOf, destinations, packContents, USED_SLOTS } from "./packs-helpers";

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
      {(pack.frameworks?.length ?? 0) > 0 && (
        <div>
          <div className="text-xs font-medium text-foreground">Frameworks ({pack.frameworks!.length}): open one to read it</div>
          <div className="mt-1 divide-y divide-border rounded-md border border-border">
            {pack.frameworks!.map((f) => <FrameworkRow key={f.name} f={f} />)}
          </div>
        </div>
      )}
      {c.captionStyles.length > 0 && <ListLine label={`Caption styles (${c.captionStyles.length})`} items={c.captionStyles} />}
    </div>
  );
}

const ROLE: Record<PackFramework["role"], string> = { narrative: "Shape: sets the order", persuasion: "Persuasion: shapes the ask", argument: "Argument: shapes the reasoning" };

/** One framework, closed to its name and role; open, everything the Workshop gets: summary, steps, when to use, example. */
function FrameworkRow({ f }: { f: PackFramework }) {
  return (
    <details className="group px-3 py-2">
      <summary className="flex cursor-pointer list-none items-baseline gap-2 text-xs">
        <span className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
        <span className="font-medium text-foreground">{f.name}</span>
        <span className="text-muted-foreground">{ROLE[f.role]}</span>
      </summary>
      <div className="mt-2 space-y-2 pl-4 text-xs text-muted-foreground">
        <p className="text-foreground">{f.summary}</p>
        <ol className="list-decimal space-y-0.5 pl-4">
          {f.steps.map((st, i) => <li key={i}>{st}</li>)}
        </ol>
        <p><span className="font-medium text-foreground">When to use it: </span>{f.whenToUse}</p>
        {f.pairsWith && <p><span className="font-medium text-foreground">Pairs with: </span>{f.pairsWith}</p>}
        {f.example && <p><span className="font-medium text-foreground">Example: </span>{f.example}</p>}
      </div>
    </details>
  );
}

/** Where a pack lands in the app, one row per place: stage, tool, the spot in it, what it does there, a link to it. */
export function WhereItGoes({ pack }: { pack: Contents }) {
  const c = containsOf(pack);
  const rows = destinations(c);
  const notes = [
    ...(c.instructions.some((s) => USED_SLOTS.includes(s)) ? ["Instructions go after the app's own and before your own rules and notes. Where they disagree, yours win. Switch them off, or keep them to some projects, under Installed."] : []),
    "Removing it deletes the copies you haven't changed and keeps the ones you have.",
  ];
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.tool + r.spot} className="rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{r.stage}</span>
            <Link to={r.to} className="font-medium text-foreground underline-offset-2 hover:underline">{r.tool}</Link>
            <span className="text-muted-foreground">›</span>
            <span className="text-foreground">{r.spot}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{r.does}</p>
        </div>
      ))}
      <ul className="list-disc space-y-1 pl-4 pt-1 text-xs text-muted-foreground">
        {notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
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
