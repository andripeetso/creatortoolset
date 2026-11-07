import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Check } from "lucide-react";
import { TOOLS, type Tool } from "@contracts/tools";
import type { WorkPrefs } from "@contracts/work-prefs";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { MyKeysSection } from "@/components/settings/MyKeysSection";
import { ProjectForm } from "@/components/workshop/ProjectForm";
import { AccountStep, hasAccountBridge } from "@/components/setup/AccountStep";
import { ConnectStep, HowPicker } from "@/components/setup/OwnAi";
import { PlanQuestion, ToolNeeds, ToolsPicker } from "@/components/setup/ToolNeeds";
import { canUse, useMe } from "@/lib/auth";
import { setupSteps, useSetup, useSetupLive, type SetupStep } from "@/lib/setup";
import { createProject } from "@/lib/workshop";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";

const STEP: Record<SetupStep, { title: string; hint: string }> = {
  how: { title: "How", hint: "Pick one. You can change it any time." },
  tools: { title: "Your tools", hint: "Which tools do you use? Tick the ones you want. Each one asks for what it needs the first time you open it; Settings → Setup changes this list." },
  project: { title: "Your first project", hint: "One project per brand: its name, your Instagram handle, and who you make it for (in Instructions)." },
  ai: { title: "Your AI", hint: "The AI runs on your own account, never anyone else's: the Claude Code or Codex you are signed in to on this Mac, on your own subscription. Or your own Anthropic API key: Anthropic bills you for what you use." },
  connect: { title: "Your own AI", hint: "Add Creator Toolset to the AI you already use. It talks to the server on this Mac, with a key only for you." },
  left: { title: "What's left", hint: "All optional: skip any of it. Each tool asks again the first time you open it, and Settings → Setup has it all." },
};

/** "Set up with chat": the in-app assistant, when this build has it (src/lib/assistant.ts); else no button. */
const assistant = Object.values(import.meta.glob<{ openAssistant: (topic: string) => void }>("/src/lib/assistant.ts"))[0];

/**
 * First-run setup: how they want to use it (in the app, in their own AI, or both: work-prefs `talk`), then setupSteps
 * for that answer: which tools → first project (Workshop or Analyzer) → AI (a tool that uses it) → connect their own
 * AI → what's left. No sign-in here: it is optional, in What's left and Settings → Setup. Each step is the same screen
 * as in Settings, so nothing here is a second copy. Opens by itself on a first sign-in until it is finished or closed,
 * again from Settings → Setup (?setup=how); an unknown ?setup= starts at the first step. Closing it is "Finish later" (done). On a phone it is a full-screen sheet.
 */
export function SetupDialog() {
  const me = useMe();
  const real = !!me;
  const view = useSetup((s) => s.view);
  const load = useSetup((s) => s.load);
  const save = useSetup((s) => s.save);
  const { projects, loaded, load: loadProjects } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const [ticked, setTicked] = useState<Tool[] | null>(null);
  const [talk, setTalk] = useState<WorkPrefs["talk"]>("app");
  const asked = params.get("setup");
  // a first sign-in, and again until it's finished once they've started
  const auto = !!view && !view.done && (view.tools !== null || (me?.logins ?? Infinity) <= 1);
  const open = real && !!view && (asked !== null || auto);

  useEffect(() => {
    if (real) void load();
  }, [real, load]);
  useEffect(() => {
    if (open && !loaded) void loadProjects();
  }, [open, loaded, loadProjects]);
  useEffect(() => {
    if (open)
      void fetch("/api/work-prefs")
        .then((r) => (r.ok ? (r.json() as Promise<WorkPrefs>) : null))
        .then((w) => w && setTalk(w.talk))
        .catch(() => {});
  }, [open]);
  useSetupLive(open);
  const savePlan = useCallback((plan: Parameters<typeof save>[0]["plan"]) => void save({ plan }), [save]);

  if (!open || !view) return null;
  const mine = TOOLS.filter((t) => canUse(me, t));
  const tools = ticked ?? view.tools ?? [];
  const steps = setupSteps(tools, talk);
  const step = steps.find((s) => s === asked) ?? steps[0]!;
  const at = steps.indexOf(step);
  const to = (s: SetupStep) => setParams((p) => (p.set("setup", s), p), { replace: true });
  const finish = () => {
    void save({ done: true });
    setTicked(null);
    setParams((p) => (p.delete("setup"), p), { replace: true });
  };
  const next = async () => {
    if (step === "tools") await save({ tools });
    const n = steps[at + 1];
    if (n) to(n);
    else finish();
  };
  const pick = async (t: WorkPrefs["talk"]) => {
    setTalk(t);
    await fetch("/api/work-prefs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ talk: t }) }).catch(() => {});
    to(setupSteps(tools, t)[1]!);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && finish()}>
      <DialogContent className="flex h-[min(860px,calc(100dvh-2rem))] w-[min(980px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none max-sm:h-dvh max-sm:w-screen max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]">
        <div className="border-b border-border px-4 pb-4 pt-5 sm:px-6">
          <DialogTitle>Set up Creator Toolset</DialogTitle>
          <DialogDescription className="mt-1">{STEP[step].hint}</DialogDescription>
          <ol className="mt-3 flex flex-wrap gap-1.5 text-xs">
            {steps.map((s, i) => (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => to(s)}
                  disabled={i > at && step === "tools" && !tools.length}
                  className={cn("flex items-center gap-1 rounded-full border px-2.5 py-1 disabled:opacity-50", s === step ? "border-violet-500 bg-violet-500/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
                >
                  {i < at ? <Check className="h-3 w-3" /> : <span>{i + 1}</span>} {STEP[s].title}
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          {step === "how" && <HowPicker value={talk} onPick={(t) => void pick(t)} />}
          {step === "connect" && <ConnectStep have={view.have} />}
          {step === "tools" && <ToolsPicker tools={mine} value={tools} onChange={setTicked} />}
          {step === "project" &&
            (projects.length ? (
              <p className="text-sm text-muted-foreground">
                You have {projects.length === 1 ? `a project: ${projects[0]!.name}` : `${projects.length} projects`}. Add more from the Workshop's project switcher.
              </p>
            ) : (
              <ProjectForm busy={false} onSave={(f) => createProject(f).then(() => void next())} />
            ))}
          {step === "ai" && (
            <>
              <ProvidersSection />
              <div className="mt-6">
                <PlanQuestion view={view} onSave={savePlan} />
              </div>
              <h3 className="mb-2 mt-6 text-sm font-medium">Or an API key of your own (not for the Content Workshop)</h3>
              <MyKeysSection only={["ANTHROPIC_API_KEY"]} />
            </>
          )}
          {step === "left" && (
            <div className="max-w-2xl">
              {tools.map((t) => (
                <ToolNeeds key={t} tool={t} have={view.have} />
              ))}
              {tools.includes("instagram") && (
                <p className="mb-4 text-xs text-muted-foreground">
                  Instagram login: later. Meta accepts its sign-in only on a web address it has checked, so the app on your Mac can't offer the official Instagram login yet. Until then your own Apify key reads posts (Apify bills you for each read).
                </p>
              )}
              {hasAccountBridge() && (
                <div className="mb-4">
                  <h3 className="mb-2 text-sm font-medium">Account (optional)</h3>
                  <AccountStep />
                </div>
              )}
              {assistant && (
                <Button size="sm" variant="outline" onClick={() => void assistant().then((m) => m.openAssistant("setup"))}>
                  Set up with chat
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
          <Button variant="ghost" size="sm" onClick={finish}>
            Finish later
          </Button>
          <div className="flex items-center gap-2">
            {step === "tools" && !tools.length && <span className="text-xs text-muted-foreground">Tick at least one</span>}
            {at > 0 && (
              <Button variant="outline" size="sm" onClick={() => to(steps[at - 1]!)}>
                Back
              </Button>
            )}
            <Button size="sm" onClick={() => void next()} disabled={step === "tools" && !tools.length}>
              {step === "left" ? "Done" : step === "project" && !projects.length ? "Skip" : "Next"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
