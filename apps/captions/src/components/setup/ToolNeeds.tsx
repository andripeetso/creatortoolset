import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import {
  AudioLines, Captions, CheckCircle2, Circle, Clapperboard, Eraser, FileText, Library, MessageSquareText, NotebookPen, ScanSearch, Scissors, Video,
  type LucideIcon,
} from "lucide-react";
import { MY_KEYS, type MyKeyEnv } from "@contracts/service-keys";
import { PLANS, type PlanId } from "@contracts/plans";
import { readiness, TOOL_LINES, TOOL_NAMES, TOOL_NEEDS, type Have, type Need, type SetupView, type Tool } from "@contracts/tools";
import { Button } from "@/components/ui/button";
import { ConnectorsSection } from "@/components/settings/ConnectorsSection";
import { MyKeysSection } from "@/components/settings/MyKeysSection";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { ProjectForm } from "@/components/workshop/ProjectForm";
import { createProject } from "@/lib/workshop";
import { Choice } from "./Choice";

const isKey = (h: Have): h is MyKeyEnv => MY_KEYS.some((k) => k.env === h);

/** The screen that sets one row up: the same form Settings has, never a second copy. */
function NeedForm({ need }: { need: Need }) {
  const here = useLocation();
  if (need.form === "keys") return <MyKeysSection only={need.anyOf.filter(isKey)} />;
  if (need.form === "apify") return <ConnectorsSection back={here.pathname + here.search} compact />;
  if (need.form === "project") return <ProjectForm busy={false} onSave={(f) => createProject(f)} />;
  if (need.form === "library")
    return (
      <p className="text-xs text-muted-foreground">
        The <Link to="/library" className="underline">Media Library</Link> makes your library: where its files live (this Mac's disk, folders it watches in place, or a bucket) is in its storage settings.
      </p>
    );
  return (
    <>
      <ProvidersSection />
      {need.anyOf.includes("ai") && (
        <>
          <h4 className="mb-2 mt-4 text-xs font-medium">Or an API key of your own</h4>
          <MyKeysSection only={["ANTHROPIC_API_KEY"]} />
        </>
      )}
    </>
  );
}

function NeedRow({ need, met }: { need: Need; met: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-2">
      <div className="flex items-center gap-2 text-sm">
        {met ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" /> : <Circle className="h-4 w-4 shrink-0 text-muted-foreground/60" />}
        <span className={met ? "flex-1 text-muted-foreground" : "flex-1"}>{need.what}</span>
        {!met && (
          <Button size="sm" variant="outline" className="h-7" onClick={() => setOpen(!open)}>
            {open ? "Close" : "Set up"}
          </Button>
        )}
      </div>
      {open && !met && <div className="mt-2 pl-6"><NeedForm need={need} /></div>}
    </li>
  );
}

/**
 * One tool's checklist (contracts/tools.ts TOOL_NEEDS): what it needs, then what else it can do ("Also available"),
 * each row ticked from what the server sees and opening its own form in place. `missingOnly`: leave out what is done.
 */
export function ToolNeeds({ tool, have, missingOnly, title = true }: { tool: Tool; have: readonly Have[]; missingOnly?: boolean; title?: boolean }) {
  const r = readiness(tool, have);
  const needs = TOOL_NEEDS[tool].filter((n) => !n.optional && (!missingOnly || r.missing.includes(n)));
  const extra = TOOL_NEEDS[tool].filter((n) => n.optional && (!missingOnly || r.extra.includes(n)));
  const met = (n: Need) => !r.missing.includes(n) && !r.extra.includes(n);
  return (
    <section className="mb-4">
      {title && (
        <h3 className="flex items-center gap-2 text-sm font-medium">
          {TOOL_NAMES[tool]}
          <span className={r.ready ? "text-xs font-normal text-emerald-600 dark:text-emerald-400" : "text-xs font-normal text-muted-foreground"}>{r.ready ? "ready" : "needs setting up"}</span>
        </h3>
      )}
      {!TOOL_NEEDS[tool].length && <p className="text-xs text-muted-foreground">Needs nothing: it works as it is.</p>}
      {needs.length > 0 && <ul className="divide-y divide-border">{needs.map((n) => <NeedRow key={n.what} need={n} met={met(n)} />)}</ul>}
      {extra.length > 0 && (
        <>
          <p className="mt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Also available</p>
          <ul className="divide-y divide-border">{extra.map((n) => <NeedRow key={n.what} need={n} met={met(n)} />)}</ul>
        </>
      )}
    </section>
  );
}

/** "Which tools do you use?": a card per tool the account may use, ticked or not. */
/** Each tool's icon, the same as on Home. */
const TOOL_ICONS: Record<Tool, LucideIcon> = {
  instagram: ScanSearch, workshop: NotebookPen, enhance: AudioLines, captions: Captions, review: MessageSquareText, media: Library,
  editor: Clapperboard, clean: Eraser, stories: Scissors, notes: Video, guides: FileText,
};

export function ToolsPicker({ tools, value, onChange }: { tools: readonly Tool[]; value: readonly Tool[]; onChange: (next: Tool[]) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {tools.map((t) => {
        const on = value.includes(t);
        return (
          <Choice
            key={t}
            multi
            on={on}
            onClick={() => onChange(on ? value.filter((x) => x !== t) : tools.filter((x) => x === t || value.includes(x)))}
            icon={TOOL_ICONS[t]}
            name={TOOL_NAMES[t]}
            line={TOOL_LINES[t]}
          />
        );
      })}
    </div>
  );
}

/**
 * "Which plan are you on?": filled in from what the CLI itself reported (the Mac app asks `claude auth status`), never
 * from its files. The plan decides the warnings before heavy runs; "Not sure" means none.
 */
export function PlanQuestion({ view, onSave }: { view: SetupView; onSave: (plan: PlanId | null) => void }) {
  const value = view.plan ?? view.detected;
  // the CLI said it: keep that as the answer, once (a later "Not sure" stays)
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || view.plan || !view.detected) return;
    prefilled.current = true;
    onSave(view.detected);
  }, [view.plan, view.detected, onSave]);
  return (
    <label className="flex flex-col gap-1 text-sm sm:w-80">
      <span className="font-medium">Which plan are you on?</span>
      <select value={value ?? ""} onChange={(e) => onSave((e.target.value || null) as PlanId | null)} className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" aria-label="Which plan are you on?">
        <option value="">Not sure</option>
        {PLANS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <span className="text-xs text-muted-foreground">
        {view.detected && view.detected === value ? "Your Claude Code says so. " : ""}On Pro or Plus, heavy runs (the AI Editor, deep research, big Analyzer runs) ask first: they can use up the 5-hour limit.
      </span>
    </label>
  );
}
