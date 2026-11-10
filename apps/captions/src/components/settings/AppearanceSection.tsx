import type { ReactNode } from "react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useShareTheme, type ThemeChoice } from "@/components/ShareTheme";
import { Switch } from "@/components/ui/switch";
import { canUse, useMe } from "@/lib/auth";
import { persistHomeGlow, persistOwnColour, persistProjectTint, useAppearance } from "@/lib/settings";
import { useSetup, useSetupLive } from "@/lib/setup";
import { DEFAULT_TOOLS, TOOLS, TOOL_LINES, TOOL_NAMES, type Tool } from "@contracts/tools";
import { cn } from "@/lib/utils";
import { PROJECT_COLORS, projectColor, useWorkspace, type ProjectColor } from "@/lib/workspace";
import { Card, Row, Section, saveFailed } from "./ui";

const OPTIONS: Array<{ id: ThemeChoice; label: string; icon: LucideIcon }> = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

// each preview is drawn in its own theme's colours (a preview cannot follow the theme it previews)
const LOOKS = {
  light: { page: "#ffffff", rail: "#f4f4f5", line: "#d4d4d8", soft: "#e4e4e7", edge: "#e4e4e7" },
  dark: { page: "#0b0b10", rail: "#111116", line: "#3f3f46", soft: "#27272a", edge: "#27272a" },
};
type Look = keyof typeof LOOKS;

/** The app in small: the side rail with the current tool, a heading and a card of rows. The accent is the live one. */
function Preview({ look }: { look: Look }) {
  const c = LOOKS[look];
  const line = (w: string, colour = c.line) => <span className="h-1.5 rounded-full" style={{ width: w, background: colour }} />;
  const row = (w: string, on: boolean) => (
    <span className="flex items-center justify-between px-2 py-1.5">
      {line(w)}
      <span className={cn("h-2 w-3.5 rounded-full", on && "bg-violet-500")} style={on ? undefined : { background: c.soft }} />
    </span>
  );
  return (
    <span className="absolute inset-0 flex" style={{ background: c.page }}>
      <span className="flex w-[30%] flex-col gap-1.5 p-2" style={{ background: c.rail, borderRight: `1px solid ${c.edge}` }}>
        <span className="mb-1 h-2.5 rounded" style={{ background: c.soft }} />
        <span className="h-1.5 w-4/5 rounded-full bg-violet-500" />
        {line("60%")}
        {line("75%")}
        {line("50%")}
      </span>
      <span className="flex flex-1 flex-col gap-2 p-2.5">
        {line("35%")}
        <span className="flex flex-col rounded-md" style={{ border: `1px solid ${c.edge}` }}>
          {row("45%", true)}
          <span className="h-px" style={{ background: c.edge }} />
          {row("60%", false)}
          <span className="h-px" style={{ background: c.edge }} />
          {row("40%", true)}
        </span>
      </span>
    </span>
  );
}

/** Settings → Appearance: the theme, the colour, then which tools Home shows. */
export function AppearanceSection() {
  const { choice, setChoice, dark } = useShareTheme();
  return (
    <>
      <Section id="theme" title="Theme">
        <div role="radiogroup" aria-label="Theme" className="grid max-w-2xl grid-cols-3 gap-3">
          {OPTIONS.map((o) => {
            const on = choice === o.id;
            const Icon = o.icon;
            return (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setChoice(o.id)}
                className={cn(
                  "flex flex-col gap-2.5 rounded-xl border p-2.5 text-left transition-colors",
                  on ? "border-violet-500 bg-violet-500/10" : "border-border/60 hover:bg-accent",
                )}
              >
                <span className="relative block aspect-[16/10] w-full overflow-hidden rounded-md border border-border/60">
                  {o.id === "system" ? (
                    <>
                      <Preview look="light" />
                      {/* the right half in dark: the theme follows the computer */}
                      <span className="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
                        <Preview look="dark" />
                      </span>
                    </>
                  ) : (
                    <Preview look={o.id} />
                  )}
                </span>
                <span className="flex items-center gap-1.5 px-0.5 text-sm text-foreground">
                  <Icon className="size-3.5" /> {o.label}
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <Colour dark={dark} />
      <ToolsOnHome />
    </>
  );
}

/** The hidden list after one tool's switch changes: on removes it from the list, off adds it. */
export function hiddenAfter(hidden: readonly Tool[], tool: Tool, on: boolean): Tool[] {
  return on ? hidden.filter((x) => x !== tool) : [...hidden.filter((x) => x !== tool), tool];
}

const COLOURS = Object.keys(PROJECT_COLORS) as ProjectColor[];
const fill = (c: ProjectColor) => `rgb(${PROJECT_COLORS[c].rgb})`;
const name = (c: ProjectColor) => c[0].toUpperCase() + c.slice(1);

/**
 * The colour the app wears: the current project's, or one of the person's own. One choice, so picking a colour is
 * also what stops following the project. The glow behind Home is dark theme only: its switch sits in the heading's
 * line, so it comes and goes with the theme without moving anything under it.
 */
function Colour({ dark }: { dark: boolean }) {
  const { projectTint, homeGlow, ownColour } = useAppearance();
  const projects = useWorkspace((s) => s.projects);
  // the Project tile is striped with the colours the person's projects have (all eight before the first project)
  const theirs = [...new Set(projects.map((p) => projectColor(p, projects)))];
  const stripes = theirs.length ? theirs : COLOURS;
  const tile = (key: string, label: string, on: boolean, pick: () => void, swatch: ReactNode) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={on}
      onClick={pick}
      className={cn(
        "flex w-[4.5rem] flex-col items-center gap-1.5 rounded-xl border p-2 text-xs transition-colors",
        on ? "border-violet-500 bg-violet-500/10 text-foreground" : "border-border/60 text-muted-foreground hover:bg-accent",
      )}
    >
      <span className="flex h-9 w-full overflow-hidden rounded-md">{swatch}</span>
      {label}
    </button>
  );
  return (
    <Section
      id="colour"
      title="Colour"
      action={
        dark && (
          <label data-settings-row="background-glow" className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            Glow behind Home
            <Switch checked={homeGlow} aria-label="Glow behind Home" onCheckedChange={persistHomeGlow} />
          </label>
        )
      }
    >
      <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-2">
        {tile(
          "project",
          "Project",
          projectTint,
          () => persistProjectTint(true),
          stripes.map((c) => <span key={c} className="flex-1" style={{ background: fill(c) }} />),
        )}
        {COLOURS.map((c) =>
          tile(c, name(c), !projectTint && ownColour === c, () => persistOwnColour(c), <span className="flex-1" style={{ background: fill(c) }} />),
        )}
      </div>
    </Section>
  );
}

/**
 * One switch per tool Home may hide (the Extras), each with what the tool does. Every switch starts on, so Home is what
 * it was until one is turned off. The Plan and Make tools have no switch: Home always shows them.
 */
function ToolsOnHome() {
  const me = useMe();
  const view = useSetup((s) => s.view);
  const save = useSetup((s) => s.save);
  useSetupLive(true);
  const switchable = TOOLS.filter((t) => canUse(me, t) && !DEFAULT_TOOLS.includes(t));
  const hidden = view?.hidden ?? [];
  const onHidden = async (next: Tool[]) => {
    try {
      await save({ hidden: next });
    } catch {
      saveFailed("The tools did not save. Try again.");
    }
  };
  return (
    <Section title="Tools on Home">
      <Card>
        {view &&
          switchable.map((t) => (
            <Row
              key={t}
              id={`home-tool-${t}`}
              title={TOOL_NAMES[t]}
              description={TOOL_LINES[t]}
              control={
                <Switch
                  checked={!hidden.includes(t)}
                  aria-label={TOOL_NAMES[t]}
                  onCheckedChange={(on) => void onHidden(hiddenAfter(hidden, t, on))}
                />
              }
            />
          ))}
      </Card>
    </Section>
  );
}
