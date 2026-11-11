import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronDown, Diff, Eye, Highlighter, LayoutGrid, ListChecks, Pencil, Shapes } from "lucide-react";
import {
  FRAMEWORK_ROLES,
  type FrameworkRole,
  type WorkshopDocument,
  type WorkshopFramework,
  type WorkshopRule,
} from "@/lib/workshop";
import { FrameworkChip } from "./FrameworkChip";

export interface DocSettingsPatch {
  kind?: WorkshopDocument["kind"];
  frameworkIds?: string[];
  ruleIds?: string[] | null;
  carouselType?: string | null;
}

const ROLE_RANK: Record<FrameworkRole, number> = { narrative: 0, persuasion: 1, argument: 2 };
const roleOf = (fws: WorkshopFramework[], id: string): FrameworkRole => fws.find((f) => f.id === id)?.role ?? "narrative";
const sortByRole = (ids: string[], fws: WorkshopFramework[]) => [...ids].sort((a, b) => ROLE_RANK[roleOf(fws, a)] - ROLE_RANK[roleOf(fws, b)]);

const barBtn = "flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50";
/** A tool's name on the writing header: left out where the header is narrow, where the icon stands alone (DocumentTabs). */
const barName = "docbar-narrow:hidden";

/** Preview / Visualize — same header row as type and versions. */
export function DocView({
  kind,
  preview,
  onPreview,
  onVisualize,
  notMine,
  onNotMine,
  changes,
  onChanges,
}: {
  kind: WorkshopDocument["kind"];
  preview: boolean;
  onPreview: () => void;
  onVisualize?: () => void;
  /** "Not mine": mark every word of the AI's text that you never said. */
  notMine?: boolean;
  onNotMine?: () => void;
  /** Shade what the last AI turn wrote on the piece. */
  changes?: boolean;
  onChanges?: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {kind !== "notes" && onChanges ? (
        <button
          type="button"
          onClick={onChanges}
          aria-pressed={!!changes}
          className={`${barBtn} ${changes ? "!text-emerald-300" : ""}`}
          title={changes ? "Showing what the AI's last reply changed (in green). Click to hide." : "Show what the AI's last reply changed on the piece (in green)"}
          aria-label="AI changes"
        >
          <Diff className="h-3 w-3" /> <span className={barName}>Changes</span>
        </button>
      ) : null}
      {kind !== "notes" && onNotMine ? (
        <button
          type="button"
          onClick={onNotMine}
          aria-pressed={!!notMine}
          className={`${barBtn} ${notMine ? "!text-amber-300" : ""}`}
          title={notMine ? "Not mine is on: every word on the AI's slides that you never said in this session is marked. Click to turn it off." : "Not mine: mark every word on the AI's slides that you never said in this session"}
          aria-label="Not mine"
        >
          <Highlighter className="h-3 w-3" />
        </button>
      ) : null}
      {kind === "carousel" && onVisualize ? (
        <button type="button" onClick={onVisualize} className={barBtn} title="Visualize: the slides side by side" aria-label="Visualize">
          <LayoutGrid className="h-3 w-3" /> <span className={barName}>Visualize</span>
        </button>
      ) : null}
      <button type="button" onClick={onPreview} className={barBtn} title={preview ? "Back to editing" : "Preview: the piece as it reads"} aria-label={preview ? "Edit" : "Preview"}>
        {preview ? <Pencil className="h-3 w-3" /> : <Eye className="h-3 w-3" />} <span className={barName}>{preview ? "Edit" : "Preview"}</span>
      </button>
    </div>
  );
}

/** Shape and rules as popovers on the writing header. */
export function DocShapeRules({
  doc,
  frameworks,
  rules,
  busy,
  onPatch,
}: {
  doc: WorkshopDocument;
  frameworks: WorkshopFramework[];
  rules: WorkshopRule[];
  busy: boolean;
  onPatch: (patch: DocSettingsPatch) => void;
}) {
  const [open, setOpen] = useState<"shape" | "rules" | null>(null);
  const activeRules = doc.ruleIds ?? rules.filter((r) => r.on).map((r) => r.id);
  const toggleFramework = (f: WorkshopFramework) => {
    const cur = doc.frameworkIds;
    const next = cur.includes(f.id) ? cur.filter((id) => id !== f.id) : [...cur.filter((id) => roleOf(frameworks, id) !== (f.role ?? "narrative")), f.id];
    onPatch({ frameworkIds: sortByRole(next, frameworks) });
  };
  const toggleRule = (id: string) => {
    const next = activeRules.includes(id) ? activeRules.filter((x) => x !== id) : [...activeRules, id];
    onPatch({ ruleIds: next });
  };
  const shapeNames = doc.frameworkIds.map((id) => frameworks.find((f) => f.id === id)?.name).filter(Boolean);
  if (doc.kind === "notes") return null;
  return (
    <div className="flex items-center gap-0.5">
      <CraftMenu
        icon={<Shapes className="h-3 w-3" />}
        label="Shape"
        summary={shapeNames.length ? shapeNames.join(", ") : "none"}
        open={open === "shape"}
        onToggle={() => setOpen((o) => (o === "shape" ? null : "shape"))}
      >
        <div className="flex flex-col gap-1.5">
          {FRAMEWORK_ROLES.map((role) => {
            const group = frameworks.filter((f) => (f.role ?? "narrative") === role.id);
            if (!group.length) return null;
            return (
              <div key={role.id} className="flex flex-wrap items-center gap-1">
                <span className="text-[10px] text-muted-foreground" title={role.hint}>
                  {role.label}
                </span>
                {group.map((f) => (
                  <FrameworkChip
                    key={f.id}
                    framework={f}
                    on={doc.frameworkIds.includes(f.id)}
                    order={doc.frameworkIds.length > 1 && doc.frameworkIds.includes(f.id) ? sortByRole(doc.frameworkIds, frameworks).indexOf(f.id) + 1 : undefined}
                    onToggle={() => !busy && toggleFramework(f)}
                  />
                ))}
              </div>
            );
          })}
          {frameworks.length === 0 && (
            <Link to="/workshop" className="text-[11px] text-muted-foreground hover:text-foreground">
              No frameworks yet — add some
            </Link>
          )}
        </div>
      </CraftMenu>
      <CraftMenu
        icon={<ListChecks className="h-3 w-3" />}
        label="Rules"
        summary={`${activeRules.length}/${rules.length}`}
        open={open === "rules"}
        onToggle={() => setOpen((o) => (o === "rules" ? null : "rules"))}
      >
        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {rules.map((r) => (
            <label key={r.id} className="flex items-start gap-2 rounded-md px-1 py-0.5 text-[11px] text-foreground hover:bg-muted/60" title={r.text}>
              <input type="checkbox" checked={activeRules.includes(r.id)} disabled={busy} onChange={() => toggleRule(r.id)} className="mt-0.5 accent-violet-500" />
              <span>
                <span className="font-medium">{r.name}</span>
                <span className="text-muted-foreground"> — {r.text}</span>
              </span>
            </label>
          ))}
          {rules.length === 0 && <span className="text-[11px] text-muted-foreground">No rules yet.</span>}
        </div>
      </CraftMenu>
    </div>
  );
}

function CraftMenu({
  icon,
  label,
  summary,
  open,
  onToggle,
  children,
}: {
  /** stands for the name where the header is narrow */
  icon: ReactNode;
  label: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <span className="relative shrink-0">
      <button type="button" onClick={onToggle} className={barBtn} aria-expanded={open} aria-label={label} title={`${label}: ${summary}`}>
        <span className="hidden docbar-narrow:inline">{icon}</span>
        <span className={barName}>{label}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 ${barName} ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-40 mt-1 w-[22rem] rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl">{children}</div>
      ) : null}
    </span>
  );
}
