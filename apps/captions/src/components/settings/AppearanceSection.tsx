import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useShareTheme, type ThemeChoice } from "@/components/ShareTheme";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import {
  persistHomeGlow,
  persistProjectTint,
  useAppearance,
} from "@/lib/settings";
import { Card, Group, Row } from "./ui";

const OPTIONS: Array<{
  id: ThemeChoice;
  label: string;
  icon: LucideIcon;
  swatch: string;
}> = [
  {
    id: "system",
    label: "System",
    icon: Monitor,
    swatch: "bg-gradient-to-r from-[#fafafa] to-[#0b0b10]",
  },
  {
    id: "light",
    label: "Light",
    icon: Sun,
    swatch: "border border-[#d4d4d8] bg-[#fafafa]",
  },
  { id: "dark", label: "Dark", icon: Moon, swatch: "border border-[#27272a] bg-[#0b0b10]" },
];

/** Settings → Appearance. The theme (the app and the caption/document links you share), and the home page's colour. */
export function AppearanceSection() {
  const { choice, setChoice } = useShareTheme();
  const { projectTint, homeGlow } = useAppearance();
  return (
    <>
      <Group title="Theme" hint="The app and the links you share. System follows the device.">
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid max-w-xl grid-cols-3 gap-3"
        >
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
                  "flex flex-col gap-3 rounded-lg border p-3 text-left transition-colors",
                  on
                    ? "border-violet-500 bg-violet-500/10"
                    : "border-border hover:bg-accent",
                )}
              >
                <span
                  className={cn("block h-16 w-full rounded-md", o.swatch)}
                />
                <span className="flex items-center gap-1.5 text-sm text-foreground">
                  <Icon className="h-3.5 w-3.5" /> {o.label}
                </span>
              </button>
            );
          })}
        </div>
      </Group>
      <Group title="Home">
        <Card>
          <Row
            label="Project colour"
            hint="Tools take the current project's colour. Off: violet everywhere."
          >
            <Switch
              checked={projectTint}
              aria-label="Project colour"
              onCheckedChange={persistProjectTint}
            />
          </Row>
          <Row
            label="Background glow"
            hint="A faint glow of that colour behind the tools, in the dark theme."
          >
            <Switch
              checked={homeGlow}
              aria-label="Background glow"
              onCheckedChange={persistHomeGlow}
            />
          </Row>
        </Card>
      </Group>
    </>
  );
}
