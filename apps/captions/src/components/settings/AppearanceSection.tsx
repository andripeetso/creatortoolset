import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useShareTheme, type ThemeChoice } from "@/components/ShareTheme";
import { ToolsPicker } from "@/components/setup/ToolNeeds";
import { Switch } from "@/components/ui/switch";
import { canUse, useMe } from "@/lib/auth";
import { persistHomeGlow, persistProjectTint, useAppearance } from "@/lib/settings";
import { useSetup, useSetupLive } from "@/lib/setup";
import { TOOLS, type Tool } from "@contracts/tools";
import { cn } from "@/lib/utils";
import { Card, Row, Section, saveFailed } from "./ui";

const OPTIONS: Array<{ id: ThemeChoice; label: string; icon: LucideIcon; swatch: string }> = [
  { id: "system", label: "System", icon: Monitor, swatch: "bg-gradient-to-r from-[#fafafa] to-[#0b0b10]" },
  { id: "light", label: "Light", icon: Sun, swatch: "border border-[#d4d4d8] bg-[#fafafa]" },
  { id: "dark", label: "Dark", icon: Moon, swatch: "border border-[#27272a] bg-[#0b0b10]" },
];

/** Settings → Appearance: the theme, then what the Home page shows. */
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

      <Home dark={dark} />
    </>
  );
}

/** The home page: which tools it shows, the project colour, and the glow (dark theme only, so it is hidden in light). */
function Home({ dark }: { dark: boolean }) {
  const me = useMe();
  const view = useSetup((s) => s.view);
  const save = useSetup((s) => s.save);
  const { projectTint, homeGlow } = useAppearance();
  useSetupLive(true);
  const mine = TOOLS.filter((t) => canUse(me, t));
  const onTools = async (tools: Tool[]) => {
    try {
      await save({ tools });
    } catch {
      saveFailed("The tools did not save. Try again.");
    }
  };
  return (
    <Section title="Home">
      <Card>
        <Row id="home-tools" title="Tools on Home" control={undefined}>
          {view && <ToolsPicker tools={mine} value={view.tools ?? []} onChange={(t) => void onTools(t)} />}
        </Row>
        <Row
          id="project-colour"
          title="Project colour"
          description="Off: violet everywhere."
          control={<Switch checked={projectTint} aria-label="Project colour" onCheckedChange={persistProjectTint} />}
        />
        {dark && (
          <Row
            id="background-glow"
            title="Background glow"
            description="A faint glow of the project colour behind the tools. Dark theme only."
            control={<Switch checked={homeGlow} aria-label="Background glow" onCheckedChange={persistHomeGlow} />}
          />
        )}
      </Card>
    </Section>
  );
}
