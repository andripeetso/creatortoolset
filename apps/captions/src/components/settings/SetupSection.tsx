import { useCallback, useState } from "react";
import { Link } from "react-router";
import { CheckCircle2, Circle } from "lucide-react";
import { MY_KEYS } from "@contracts/service-keys";
import { readiness, toolsUsing, TOOL_NAMES, TOOLS, type Have, type Tool } from "@contracts/tools";
import { Button } from "@/components/ui/button";
import { PlanQuestion, ToolNeeds, ToolsPicker } from "@/components/setup/ToolNeeds";
import { canUse, useMe } from "@/lib/auth";
import { useSetup, useSetupLive, useWorkTalk } from "@/lib/setup";
import { Card, Group, Loading, Row } from "./ui";
import { HowYouWorkDialog } from "./HowYouWorkDialog";

const HOW_NAMES = { app: "In the app", chat: "In my own AI", both: "Both" } as const;

const HAVE_NAMES: Array<[Have, string]> = [
  ["ownAi", "Your own AI (Claude Code or Codex)"],
  ["ai", "AI (your own, or an API key)"],
  ["project", "A Workshop project"],
  ["library", "A Media Library"],
  ["apify", "Apify key"],
  ...MY_KEYS.map((k): [Have, string] => [k.env, `${k.name} key`]),
];

/**
 * Settings → General, the setup part: how you work (and run setup again), each tool you may use with what it still
 * needs, the tools you use and your plan.
 */
export function SetupSection() {
  const me = useMe();
  const view = useSetup((s) => s.view);
  const save = useSetup((s) => s.save);
  const [open, setOpen] = useState<Tool | null>(null);
  const [howOpen, setHowOpen] = useState(false);
  const { talk } = useWorkTalk();
  useSetupLive(true);
  const savePlan = useCallback((plan: Parameters<typeof save>[0]["plan"]) => void save({ plan }), [save]);
  if (!view) return <Loading />;
  const mine = TOOLS.filter((t) => canUse(me, t));

  return (
    <>
      <Group title="Setup" hint="Change it any time. Your tools, projects and connections stay.">
        <Card>
          <Row label="You work" hint="The assistant and your own AI: what each answer changes">
            <span className="text-sm text-foreground">{HOW_NAMES[talk ?? "app" as keyof typeof HOW_NAMES]}</span>
            <Button size="sm" variant="outline" className="h-7" onClick={() => setHowOpen(true)}>
              Change
            </Button>
          </Row>
          <Row label="Run setup again" hint="The first-run walk-through: how you work, what you make, a project, your AI.">
            <Button asChild size="sm" variant="outline" className="h-7">
              <Link to="/?setup=how">Run setup</Link>
            </Button>
          </Row>
        </Card>
        {howOpen && <HowYouWorkDialog onClose={() => setHowOpen(false)} />}
      </Group>

      <Group title="By tool" hint="Each tool you may use: ready, or what it still needs. Set up opens the same forms as the rest of Settings.">
        <Card>
          {mine.map((t) => {
            const r = readiness(t, view.have);
            return (
              <div key={t}>
                <Row label={TOOL_NAMES[t]} hint={r.ready ? "Ready" : `Needs: ${r.missing.map((n) => n.what).join("; ")}`}>
                  {r.ready ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : null}
                  <Button size="sm" variant="outline" className="h-7" onClick={() => setOpen(open === t ? null : t)}>
                    {open === t ? "Close" : r.ready ? "More" : "Set up"}
                  </Button>
                </Row>
                {open === t && (
                  <div className="px-4 pb-3">
                    <ToolNeeds tool={t} have={view.have} title={false} />
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      </Group>

      <Group title="Your tools" hint="The tools you use. A tool you tick shows what it needs the first time you open it.">
        <ToolsPicker tools={mine} value={view.tools ?? []} onChange={(tools) => void save({ tools })} />
      </Group>

      <Group title="Your plan">
        <PlanQuestion view={view} onSave={savePlan} />
      </Group>
    </>
  );
}

/**
 * Settings → API keys, first part: every key and login with the tools it turns on, and whether it is set. Keys stay on
 * this Mac; each is billed by its own service, to the account.
 */
export function KeyReadiness() {
  const me = useMe();
  const view = useSetup((s) => s.view);
  useSetupLive(true);
  if (!view) return <Loading />;
  const mine = TOOLS.filter((t) => canUse(me, t));
  const has = new Set(view.have);
  return (
    <Group title="Keys and the tools they turn on" hint="Keys stay on this Mac. Each one is billed by its own service, to your account. Check its price before you add it.">
      <Card>
        {HAVE_NAMES.filter(([h]) => toolsUsing(h).some((t) => mine.includes(t))).map(([h, name]) => (
          <Row
            key={h}
            label={
              <span className="flex items-center gap-2">
                {has.has(h) ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Circle className="h-4 w-4 text-muted-foreground/60" />}
                {name}
              </span>
            }
            hint={toolsUsing(h).filter((t) => mine.includes(t)).map((t) => TOOL_NAMES[t]).join(", ")}
          />
        ))}
      </Card>
    </Group>
  );
}
