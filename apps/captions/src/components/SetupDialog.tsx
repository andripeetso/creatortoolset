import { useCallback, useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import {
  ArrowRight,
  AtSign,
  CheckCircle2,
  CircleEllipsis,
  GalleryHorizontalEnd,
  GraduationCap,
  Mail,
  Megaphone,
  Mic,
  MonitorPlay,
  Newspaper,
  ScreenShare,
  Smartphone,
  X,
  type LucideIcon,
} from "lucide-react";
import { readiness, TOOL_NAMES, TOOLS, type Tool } from "@contracts/tools";
import { MAKES, type Make, type WorkPrefs } from "@contracts/work-prefs";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { MyKeysSection } from "@/components/settings/MyKeysSection";
import { ProjectForm } from "@/components/workshop/ProjectForm";
import { AccountStep, hasAccountBridge } from "@/components/setup/AccountStep";
import { Choice } from "@/components/setup/Choice";
import { ConnectStep, HowPicker } from "@/components/setup/OwnAi";
import { PlanQuestion, ToolNeeds, ToolsPicker } from "@/components/setup/ToolNeeds";
import { canUse, useMe } from "@/lib/auth";
import { MAKE_NAMES, setupFinished, setupSteps, toolsFor, useSetup, useSetupLive, type SetupStep } from "@/lib/setup";
import { createProject } from "@/lib/workshop";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";

/** Each step: the question as its title, one line under it. */
const STEP: Record<SetupStep, { title: string; hint: string }> = {
  how: { title: "How do you want to work?", hint: "Pick one. You can change it any time in Settings." },
  make: { title: "What will you make?", hint: "Pick everything that fits. It switches on the right tools for you." },
  tools: { title: "Your tools", hint: "Ticked from what you make. Each tool asks for what it needs the first time you open it." },
  project: { title: "Your first project", hint: "One project per brand or channel: its name, your handle, and who it's for." },
  ai: { title: "Connect your AI", hint: "The AI runs on your own Claude Code or Codex, on this Mac and your own plan." },
  connect: { title: "Add Creator Toolset to your AI", hint: "One click adds it to the Claude Code or Codex on this Mac, with a key only for you." },
  left: { title: "Almost done", hint: "All optional: set up what you want now. Each tool asks again when you open it, and Settings → Setup has it all." },
};

const MAKE_ICONS: Record<Make, LucideIcon> = {
  reel: Smartphone, youtube: MonitorPlay, carousel: GalleryHorizontalEnd, ad: Megaphone, podcast: Mic, course: GraduationCap,
  recording: ScreenShare, newsletter: Mail, thread: AtSign, article: Newspaper, other: CircleEllipsis,
};

/** Closing setup hides it until the app opens again (sessionStorage) and remembers the step for "Finish setting up". */
const LATER = "ct-setup-later";
const stored = (key: string) => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null; // no storage: it just opens again on the next page load
  }
};

const PROJECT_FORM = "ct-setup-project";

const putPrefs = (p: Partial<WorkPrefs>) =>
  fetch("/api/work-prefs", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) }).catch(() => {});

/**
 * First-run setup, one step at a time in one window: how they want to use it (work-prefs `talk`), then setupSteps for
 * that answer: what they make (work-prefs `makes`, it pre-ticks the tools) → which tools → first project (Workshop or
 * Analyzer) → AI (a tool that uses it) → connect their own AI → what's left. No sign-in here: it is optional, in What's
 * left and Settings → Setup. Each step is the same form as in Settings, so nothing here is a second copy.
 *
 * Opens by itself until Done on the last step (setupFinished). Closing it (the X, Escape, Finish later) only hides it
 * until the app opens again; a click outside does nothing, so moving the window by its title bar never closes it. While
 * hidden, Home shows "Finish setting up", which reopens it at the step they left (?setup=<step>). On a phone it is a
 * full-screen sheet.
 */
export function SetupDialog() {
  const me = useMe();
  const real = !!me;
  const view = useSetup((s) => s.view);
  const load = useSetup((s) => s.load);
  const save = useSetup((s) => s.save);
  const { projects, loaded, load: loadProjects } = useWorkspace();
  const { pathname } = useLocation();
  const [params, setParams] = useSearchParams();
  const [ticked, setTicked] = useState<Tool[] | null>(null);
  const [prefs, setPrefs] = useState<WorkPrefs | null>(null);
  const [later, setLater] = useState(() => stored(LATER) !== null);
  const asked = params.get("setup");
  const talk = prefs?.talk ?? "app";
  const makes = prefs?.makes ?? [];
  const finished = !!view && !!prefs && setupFinished(view, talk);
  const open = real && !!view && !!prefs && (asked !== null || (!finished && !later));

  useEffect(() => {
    if (real) void load();
  }, [real, load]);
  useEffect(() => {
    if (!real) return;
    void fetch("/api/work-prefs")
      .then((r) => (r.ok ? (r.json() as Promise<WorkPrefs>) : null))
      .then((w) => setPrefs(w ?? { talk: "app", check: "app", editor: null, makes: [] }))
      .catch(() => {});
  }, [real]);
  useEffect(() => {
    if (open && !loaded) void loadProjects();
  }, [open, loaded, loadProjects]);
  useSetupLive(open);
  const savePlan = useCallback((plan: Parameters<typeof save>[0]["plan"]) => void save({ plan }), [save]);

  if (!real || !view || !prefs) return null;
  const mine = TOOLS.filter((t) => canUse(me, t));
  const tools = ticked ?? view.tools ?? [];
  const steps = setupSteps(tools, talk);
  const step = steps.find((s) => s === asked) ?? steps[0]!;
  const at = steps.indexOf(step);
  const to = (s: SetupStep) => setParams((p) => (p.set("setup", s), p), { replace: true });
  const close = () => {
    try {
      sessionStorage.setItem(LATER, step);
    } catch {
      /* see stored() */
    }
    setLater(true);
    setParams((p) => (p.delete("setup"), p), { replace: true });
  };

  // hidden, not finished: Home offers the way back
  if (!open) {
    if (finished || pathname !== "/") return null;
    return (
      <button
        type="button"
        onClick={() => to(steps.find((s) => s === stored(LATER)) ?? step)}
        // top middle, in the bar's empty space (between the name and the project switcher), never over a tool
        className="fixed left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] z-40 flex h-8 -translate-x-1/2 items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--tint)_45%,transparent)] bg-[color-mix(in_srgb,var(--tint)_10%,transparent)] pl-3.5 pr-1 text-xs font-medium text-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--tint)_18%,transparent)] motion-safe:animate-in motion-safe:fade-in"
      >
        Finish setting up
        <span className="flex size-6 items-center justify-center rounded-full bg-[var(--tint)] text-white">
          <ArrowRight className="size-3.5" />
        </span>
      </button>
    );
  }

  const finish = () => {
    void save({ done: true });
    setTicked(null);
    setParams((p) => (p.delete("setup"), p), { replace: true });
  };
  const next = async () => {
    if (step === "make") {
      await putPrefs({ makes });
      if (makes.length) setTicked(toolsFor(makes, mine));
    }
    if (step === "tools") await save({ tools });
    const n = setupSteps(step === "make" && makes.length ? toolsFor(makes, mine) : tools, talk)[at + 1];
    if (n) to(n);
    else finish();
  };
  const pickTalk = (t: WorkPrefs["talk"]) => {
    to(step); // the open step in the address keeps it open: "In my own AI" can make an early-closed setup count as finished
    setPrefs({ ...prefs, talk: t });
    void putPrefs({ talk: t });
  };
  const toggleMake = (m: Make) =>
    setPrefs({ ...prefs, makes: makes.includes(m) ? makes.filter((x) => x !== m) : MAKES.filter((x) => x === m || makes.includes(x)) });
  const blocked = step === "tools" && !tools.length;
  const last = at === steps.length - 1;
  const newProject = step === "project" && !projects.length;

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        showCloseButton={false}
        // a press outside (the Mac window's title bar, the page behind) never closes setup
        onInteractOutside={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className={cn(
          // as tall as the step needs, its top fixed below the window's title bar: a step change only moves the bottom edge
          "top-[max(4rem,12dvh)] flex max-h-[min(680px,calc(100dvh-max(4rem,12dvh)-2rem))] w-[min(820px,calc(100vw-3rem))] max-w-none translate-y-0 flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl shadow-black/40 sm:max-w-none",
          "max-sm:top-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]",
        )}
      >
        <header className="shrink-0 px-6 pt-5 sm:px-8 sm:pt-6">
          <div className="flex items-center gap-3">
            <ol className="flex flex-1 gap-1.5" aria-label={`Step ${at + 1} of ${steps.length}`}>
              {steps.map((s, i) => (
                <li key={s} className="flex-1">
                  <button
                    type="button"
                    onClick={() => i < at && to(s)}
                    disabled={i >= at}
                    aria-label={STEP[s].title}
                    title={STEP[s].title}
                    className="block h-1.5 w-full rounded-full bg-muted transition-colors enabled:cursor-pointer enabled:hover:brightness-125"
                  >
                    <span className={cn("block h-full rounded-full transition-[width,background-color] duration-300", i <= at ? "w-full bg-[var(--tint)]" : "w-0")} />
                  </button>
                </li>
              ))}
            </ol>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {at + 1} / {steps.length}
            </span>
            <button
              type="button"
              onClick={close}
              aria-label="Finish later"
              title="Finish later"
              className="-mr-2 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
          <DialogTitle className="mt-6 text-2xl font-semibold tracking-tight">{STEP[step].title}</DialogTitle>
          <DialogDescription className="mt-1.5 text-sm">{STEP[step].hint}</DialogDescription>
        </header>

        <div key={step} className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-6 sm:px-8 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2 motion-safe:duration-200">
          {step === "how" && <HowPicker value={talk} onPick={pickTalk} />}
          {step === "make" && (
            <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="What will you make?">
              {MAKES.map((m) => (
                <Choice key={m} multi on={makes.includes(m)} onClick={() => toggleMake(m)} icon={MAKE_ICONS[m]} name={MAKE_NAMES[m]} />
              ))}
            </div>
          )}
          {step === "tools" && <ToolsPicker tools={mine} value={tools} onChange={setTicked} />}
          {step === "project" &&
            (projects.length ? (
              <p className="rounded-xl border border-border/60 bg-card/40 p-4 text-sm text-muted-foreground">
                You have {projects.length === 1 ? `a project: ${projects[0]!.name}` : `${projects.length} projects`}. Add more from the Workshop's project switcher.
              </p>
            ) : (
              <ProjectForm formId={PROJECT_FORM} busy={false} onSave={(f) => createProject(f).then(() => void next())} />
            ))}
          {step === "ai" && (
            <>
              <ProvidersSection brief />
              <div className="mt-6">
                <PlanQuestion view={view} onSave={savePlan} />
              </div>
              <details className="group mt-6 rounded-xl border border-border/60 bg-card/40">
                <summary className="cursor-pointer list-none px-4 py-3 text-sm text-muted-foreground hover:text-foreground">
                  No Claude Code or Codex? Use an Anthropic API key instead (not for the Content Workshop)
                </summary>
                <div className="px-4 pb-4">
                  <MyKeysSection only={["ANTHROPIC_API_KEY"]} />
                </div>
              </details>
            </>
          )}
          {step === "connect" && <ConnectStep have={view.have} />}
          {step === "left" && (
            <div className="space-y-2">
              {tools.some((t) => readiness(t, view.have).ready) && (
                <p className="flex items-start gap-2 rounded-xl border border-border/60 bg-card/40 px-4 py-3 text-sm">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                  <span>
                    <span className="font-medium">Ready to use:</span>{" "}
                    <span className="text-muted-foreground">{tools.filter((t) => readiness(t, view.have).ready).map((t) => TOOL_NAMES[t]).join(", ")}</span>
                  </span>
                </p>
              )}
              {tools
                .filter((t) => !readiness(t, view.have).ready)
                .map((t) => (
                  <div key={t} className="rounded-xl border border-border/60 bg-card/40 px-4 pt-3">
                    <ToolNeeds tool={t} have={view.have} missingOnly />
                  </div>
                ))}
              {tools.includes("instagram") && (
                <p className="px-1 pt-2 text-xs text-muted-foreground">
                  Instagram login: later. Meta accepts its sign-in only on a web address it has checked, so the app on your Mac can't offer the official Instagram login yet. Until then your own Apify key reads posts (Apify bills you for each read).
                </p>
              )}
              {hasAccountBridge() && (
                <div className="rounded-xl border border-border/60 bg-card/40 p-4">
                  <h3 className="mb-2 text-sm font-medium">Account (optional)</h3>
                  <AccountStep />
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={close}>
            Finish later
          </Button>
          <div className="flex items-center gap-2">
            {blocked && <span className="text-xs text-muted-foreground">Pick at least one</span>}
            {at > 0 && (
              <Button variant="ghost" onClick={() => to(steps[at - 1]!)}>
                Back
              </Button>
            )}
            {newProject && (
              <Button variant="ghost" className="text-muted-foreground" onClick={() => void next()}>
                Skip
              </Button>
            )}
            <Button
              // a first project: the button submits the project form (its own checks, then Continue)
              {...(newProject ? { type: "submit" as const, form: PROJECT_FORM } : { onClick: () => void next() })}
              disabled={blocked}
              className="min-w-28 bg-[var(--tint)] text-white hover:bg-[var(--tint)] hover:brightness-110"
            >
              {last ? "Done" : newProject ? "Create project" : "Continue"}
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
