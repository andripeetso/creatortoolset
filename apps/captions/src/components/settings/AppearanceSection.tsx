import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useShareTheme, type ThemeChoice } from "@/components/ShareTheme";
import { Switch } from "@/components/ui/switch";
import { canUse, useMe } from "@/lib/auth";
import { persistHomeGlow, persistProjectTint, useAppearance } from "@/lib/settings";
import { useSetup, useSetupLive } from "@/lib/setup";
import { DEFAULT_TOOLS, TOOLS, TOOL_LINES, TOOL_NAMES, type Tool } from "@contracts/tools";
import { cn } from "@/lib/utils";
import { Card, Row, Section, saveFailed } from "./ui";

// the swatches draw each theme's own colours (a preview cannot follow the theme it previews)
const OPTIONS: Array<{ id: ThemeChoice; label: string; icon: LucideIcon; swatch: string }> = [
  { id: "system", label: "System", icon: Monitor, swatch: "bg-gradient-to-r from-[#fafafa] to-[#0b0b10]" },
  { id: "light", label: "Light", icon: Sun, swatch: "border border-[#d4d4d8] bg-[#fafafa]" },
  { id: "dark", label: "Dark", icon: Moon, swatch: "border border-[#27272a] bg-[#0b0b10]" },
];

/** Settings → Appearance: the theme, the project colour, then which tools Home shows. */
export function AppearanceSection() {
  const { choice, setChoice, dark } = useShareTheme();
  return (
    <>
      <Section title="Theme">
        <div role="radiogroup" aria-label="Theme" className="grid max-w-xl grid-cols-3 gap-3">
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
                  "flex flex-col gap-3 rounded-xl border p-3 text-left transition-colors",
                  on ? "border-violet-500 bg-violet-500/10" : "border-border/60 hover:bg-accent",
                )}
              >
                <span className={cn("block h-16 w-full rounded-md", o.swatch)} />
                <span className="flex items-center gap-1.5 text-sm text-foreground">
                  <Icon className="size-3.5" /> {o.label}
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      {/* last: the glow row comes and goes with the theme, and nothing below it may move */}
      <ToolsOnHome />
      <Colour dark={dark} />
    </>
  );
}

/** The hidden list after one tool's switch changes: on removes it from the list, off adds it. */
export function hiddenAfter(hidden: readonly Tool[], tool: Tool, on: boolean): Tool[] {
  return on ? hidden.filter((x) => x !== tool) : [...hidden.filter((x) => x !== tool), tool];
}

/** The project colour, and the glow behind Home (dark theme only, so the row is absent in light). */
function Colour({ dark }: { dark: boolean }) {
  const { projectTint, homeGlow } = useAppearance();
  return (
    <Section title="Colour">
      <Card>
        <Row
          id="project-colour"
          title="Project colour"
          description="Tools, buttons and Home take the current project's colour."
          control={<Switch checked={projectTint} aria-label="Project colour" onCheckedChange={persistProjectTint} />}
        />
        {dark && (
          <Row
            id="background-glow"
            title="Background glow"
            description="A faint glow of the project colour behind the tools."
            control={<Switch checked={homeGlow} aria-label="Background glow" onCheckedChange={persistHomeGlow} />}
          />
        )}
      </Card>
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
