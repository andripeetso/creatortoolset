import { useState } from "react";
import { Link, useLocation } from "react-router";
import {
  AudioLines, Captions, CheckCircle2, Circle, Clapperboard, FileText, Library, MessageSquareText, NotebookPen, ScanSearch, Scissors, Video,
  type LucideIcon,
} from "lucide-react";
import { MY_KEYS, type MyKeyEnv } from "@contracts/service-keys";
import { PLANS, type PlanId } from "@contracts/plans";
import { DEFAULT_TOOLS, NEED_SENTENCE, NEED_SHORT, readiness, TOOL_LINES, TOOL_NAMES, TOOL_NEEDS, type Have, type Need, type SetupView, type Tool } from "@contracts/tools";
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

/** The welcome's wording for a need: its short name and one plain sentence (contracts/tools.ts). */
const shortOf = (n: Need): string => {
  const s = NEED_SHORT[n.anyOf[0]];
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function NeedRow({ need, met, welcome, focus }: { need: Need; met: boolean; welcome?: boolean; focus?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-2">
      <div className="flex items-center gap-2 text-sm">
        {met ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" /> : <Circle className="h-4 w-4 shrink-0 text-muted-foreground/60" />}
        <span className={met ? "flex-1 text-muted-foreground" : "flex-1"}>
          {welcome ? shortOf(need) : need.what}
          {welcome && <span className="block text-xs text-muted-foreground">{NEED_SENTENCE[need.anyOf[0]]}</span>}
        </span>
        {!met && (
          <Button size="sm" variant="outline" className="h-7" autoFocus={focus} onClick={() => setOpen(!open)}>
            {open ? "Close" : need.form === "keys" ? "Add key" : need.form === "ai" ? "Connect" : "Set up"}
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
 * `welcome`: the first-open card only: the required rows still missing, with their short names and sentences.
 */
export function ToolNeeds({ tool, have, missingOnly, title = true, welcome }: { tool: Tool; have: readonly Have[]; missingOnly?: boolean; title?: boolean; welcome?: boolean }) {
  const r = readiness(tool, have);
  const needs = TOOL_NEEDS[tool].filter((n) => !n.optional && (!missingOnly || r.missing.includes(n)));
  const extra = welcome ? [] : TOOL_NEEDS[tool].filter((n) => n.optional && (!missingOnly || r.extra.includes(n)));
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
      {needs.length > 0 && (
        <ul className="divide-y divide-border">
          {needs.map((n, i) => <NeedRow key={n.what} need={n} met={met(n)} welcome={welcome} focus={welcome && i === 0} />)}
        </ul>
      )}
      {extra.length > 0 && (
        <>
          <p className="mt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Also available</p>
          <ul className="divide-y divide-border">{extra.map((n) => <NeedRow key={n.what} need={n} met={met(n)} />)}</ul>
        </>
      )}
    </section>
  );
}

/** Each tool's icon, the same as on Home. */
export const TOOL_ICONS: Record<Tool, LucideIcon> = {
  instagram: ScanSearch, workshop: NotebookPen, enhance: AudioLines, captions: Captions, review: MessageSquareText, media: Library,
  editor: Clapperboard, stories: Scissors, notes: Video, guides: FileText,
};

/**
 * The tools, as a list: the default tools always on (shown locked, not part of the pick), then the extras as switches,
 * off unless picked. `tools` is what the account may use; `value` is what is on.
 */
export function ToolsPicker({ tools, value, onChange }: { tools: readonly Tool[]; value: readonly Tool[]; onChange: (next: Tool[]) => void }) {
  const fixed = tools.filter((t) => DEFAULT_TOOLS.includes(t));
  const extras = tools.filter((t) => !DEFAULT_TOOLS.includes(t));
  const toggle = (t: Tool) => {
    const on = value.includes(t);
    onChange(on ? value.filter((x) => x !== t) : tools.filter((x) => x === t || value.includes(x) || DEFAULT_TOOLS.includes(x)));
  };
  const card = (t: Tool, locked: boolean) => (
    <Choice
      key={t}
      multi
      locked={locked}
      on={locked || value.includes(t)}
      onClick={() => toggle(t)}
      icon={TOOL_ICONS[t]}
      name={TOOL_NAMES[t]}
      line={TOOL_LINES[t]}
    />
  );
  return (
    <div className="space-y-3">
      {fixed.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Always on</p>
          <div className="grid gap-2 sm:grid-cols-2">{fixed.map((t) => card(t, true))}</div>
        </div>
      )}
      {extras.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Extras: switch on the ones you want</p>
          <div className="grid gap-2 sm:grid-cols-2">{extras.map((t) => card(t, false))}</div>
        </div>
      )}
    </div>
  );
}

/**
 * "Which plan are you on?" (Settings → Setup only). Setup never asks, and nothing is saved from the CLI on its own:
 * the plan the CLI reported is shown as a note until the person picks one (contracts/plans.ts mapping).
 */
export function PlanQuestion({ view, onSave }: { view: SetupView; onSave: (plan: PlanId | null) => void }) {
  const reported = !view.plan && view.detected ? PLANS.find((p) => p.id === view.detected)?.label : undefined;
  return (
    <label className="flex flex-col gap-1 text-sm sm:w-80">
      <span className="font-medium">Which plan are you on?</span>
      <select value={view.plan ?? ""} onChange={(e) => onSave((e.target.value || null) as PlanId | null)} className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" aria-label="Which plan are you on?">
        <option value="">Not sure</option>
        {PLANS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <span className="text-xs text-muted-foreground">
        {reported && `Read from Claude Code: ${reported}. `}On Pro or Plus, heavy runs (the AI Editor, deep research, big Analyzer runs) ask first: they can use up the 5-hour limit.
      </span>
    </label>
  );
}
