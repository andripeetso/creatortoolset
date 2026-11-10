import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import {
  AtSign,
  Check,
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
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { NEED_SENTENCE, NEED_SHORT, TOOLS, readiness, type Have, type Need, type Tool } from "@contracts/tools";
import { MY_KEYS, type MyKeyEnv } from "@contracts/service-keys";
import { MAKES, type Make } from "@contracts/work-prefs";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConnectorsSection } from "@/components/settings/ConnectorsSection";
import { MyKeysSection } from "@/components/settings/MyKeysSection";
import { ProjectForm } from "@/components/workshop/ProjectForm";
import { AgentsStep } from "@/components/setup/AgentsStep";
import { Choice } from "@/components/setup/Choice";
import { ConnectStep, HERE } from "@/components/setup/ConnectStep";
import { FoldersStep } from "@/components/setup/FoldersStep";
import { HowPicker } from "@/components/setup/HowPicker";
import { ToolsPicker } from "@/components/setup/ToolNeeds";
import { canUse, useMe } from "@/lib/auth";
import { openAssistant } from "@/lib/assistant";
import {
  MAKE_NAMES,
  STAGES,
  STAGE_NAME,
  dismissSetup,
  neighbours,
  openSetupAt,
  rememberLater,
  setupOpen,
  setupOpensItself,
  setupStepFromParam,
  stageOf,
  stepsFor,
  toolsFor,
  useSetup,
  useSetupLive,
  useWorkPrefs,
  useWorkTalk,
  type SetupStep,
} from "@/lib/setup";
import { createProject, patchProject } from "@/lib/workshop";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";

/** Each step: its title and the line under it (SPEC 2.1, 3 to 6, 2.4). The same five steps on every path. */
const STEP: Record<SetupStep, { title: string; hint: string }> = {
  how: {
    title: "How do you work best?",
    hint: "Let's get you set up. Don't worry, nothing here locks you in, and you don't have to get it perfect. You can change any of it later in Settings → Setup.",
  },
  make: { title: "What will you make?", hint: "Pick what fits. Each one turns on the tools you'll use. You can change this any time in Settings → Setup." },
  project: {
    title: "Your first project",
    hint: "Name it and pick a colour. Add where you post if you like. All optional, and you can add more later.",
  },
  connect: {
    title: "Connect your computers",
    hint: "Choose one or more computers. We'll set up agents and folders on each.",
  },
  agents: {
    title: "Connect your agents",
    hint: "Choose an AI to work with. You can add more later.",
  },
  folders: {
    title: "Where are your videos?",
    hint: "Pick the folders where you keep your footage and music. The AI Editor and Media Library find your clips there. Nothing is moved or uploaded.",
  },
  done: {
    title: "You're ready to start",
    hint: "Everything else can be added later.",
  },
};

const MAKE_ICONS: Record<Make, LucideIcon> = {
  reel: Smartphone, youtube: MonitorPlay, carousel: GalleryHorizontalEnd, ad: Megaphone, podcast: Mic, course: GraduationCap,
  recording: ScreenShare, newsletter: Mail, thread: AtSign, article: Newspaper, other: CircleEllipsis,
};

const PROJECT_FORM = "ct-setup-project";
const SAVED_NOTE = "Your setup is saved. You'll find the rest on Home.";

const isKey = (h: Have): h is MyKeyEnv => MY_KEYS.some((k) => k.env === h);

/** The optional needs still missing for the ticked tools, one row per need (named by its first key or login). */
function moreNeeds(tools: Tool[], have: Have[]): Need[] {
  const seen = new Map<Have, Need>();
  for (const t of tools) for (const n of readiness(t, have).extra) if (!seen.has(n.anyOf[0]!)) seen.set(n.anyOf[0]!, n);
  return [...seen.values()];
}

/** One row of "More you can connect": its key form or sign-in opens in place; the rest go to the place that sets them up. */
function MoreRow({ need }: { need: Need }) {
  const [open, setOpen] = useState(false);
  const here = useLocation();
  const navigate = useNavigate();
  const h = need.anyOf[0]!;
  const inline = need.form === "keys" || need.form === "apify";
  const act = () => {
    if (inline) setOpen(!open);
    else if (need.form === "ai" || need.form === "project") openSetupAt(need.form === "ai" ? "agents" : "project");
    else navigate("/library");
  };
  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{NEED_SHORT[h]}</p>
          <p className="text-xs text-muted-foreground">{NEED_SENTENCE[h]}</p>
        </div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={act}>
          {need.form === "keys" ? "Add key" : "Set up"}
        </Button>
      </div>
      {open && inline && (
        <div className="mt-3">
          {need.form === "keys" ? <MyKeysSection only={need.anyOf.filter(isKey)} /> : <ConnectorsSection back={here.pathname + here.search} compact />}
        </div>
      )}
    </li>
  );
}

/**
 * First-run setup in one window: how you work → your computers → your agents → your video folders → what you make (ticks
 * the tools) → your first project → ready. Not now (the X, the footer link, Escape) hides
 * it for this browser and remembers the step; Home's card brings it back. A click outside never closes it.
 */
export function SetupDialog() {
  const me = useMe();
  const real = !!me;
  const view = useSetup((s) => s.view);
  const load = useSetup((s) => s.load);
  const save = useSetup((s) => s.save);
  const prefs = useWorkPrefs((s) => s.prefs);
  const loadPrefs = useWorkPrefs((s) => s.load);
  const { talk, setTalk } = useWorkTalk();
  const { projects, loaded, load: loadProjects } = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [ticked, setTicked] = useState<Tool[] | null>(null);
  const [note, setNote] = useState(false);
  const [named, setNamed] = useState(false); // the project form reports when it has a name: Create stays off until then
  const [footerSlot, setFooterSlot] = useState<HTMLElement | null>(null); // the folders step portals its buttons in
  const [unsure, setUnsure] = useState<boolean | null>(null); // "Not sure yet" ticked here; null = read it from the saved answers
  // the computers picked on the Connect step: this computer first and checked, the others unchecked until picked
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const pickedIds: ReadonlySet<string> = picked ?? new Set([HERE]);
  const pick = (id: string, on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur ?? [HERE]);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const asked = params.get("setup");
  // by itself only on a first sign-in (setupOpensItself); Settings → Setup and ?setup= always open it
  const firstRun = setupOpensItself({ logins: me?.logins, loaded, projects: projects.length });
  const open = real && !!prefs && setupOpen(view, asked) && (asked !== null || firstRun);

  useEffect(() => {
    if (real) void load();
  }, [real, load]);
  useEffect(() => {
    if (real) void loadPrefs();
  }, [real, loadPrefs]);
  useEffect(() => {
    if (real && !loaded) void loadProjects();
  }, [real, loaded, loadProjects]);
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(false), 4000);
    return () => window.clearTimeout(t);
  }, [note]);
  useSetupLive(open);

  const savedNote = note ? (
    <p role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border bg-popover px-4 py-2 text-xs text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in">
      {SAVED_NOTE}
    </p>
  ) : null;

  if (!real || !view || !prefs) return null;
  if (!open) return savedNote;

  const mine = TOOLS.filter((t) => canUse(me, t));
  const makes = prefs.makes;
  const tools = ticked ?? view.tools ?? toolsFor(makes, mine);
  const step: SetupStep = setupStepFromParam(asked) ?? "how";
  // the mode decides which steps there are (In the app: no Agents; In my own AI: no Folders)
  // from a step the mode skips (Agents opened from the assistant in In the app), Back and Continue still go the right way
  const order = stepsFor(talk);
  const stage = stageOf(step);
  const last = step === "done";
  const { before, after } = neighbours(step, talk);
  const newProject = step === "project" && !projects.length;
  const to = (s: SetupStep) => setParams((p) => (p.set("setup", s), p), { replace: true });

  const close = () => {
    rememberLater(step);
    dismissSetup();
    setNote(true);
    setParams((p) => (p.delete("setup"), p), { replace: true });
  };
  const next = async () => {
    if (step === "make") {
      await useWorkPrefs.getState().put({ makes });
      await save({ tools });
    }
    to(after);
  };
  const finish = async () => {
    await save({ done: true }).catch(() => {});
    dismissSetup();
    setParams((p) => (p.delete("setup"), p), { replace: true });
    // working in the app: setup ends on the assistant, where a dropped video and one sentence get it done
    if (talk !== "chat") openAssistant();
    navigate("/review");
  };
  const setMakes = (next: Make[]) => {
    useWorkPrefs.setState({ prefs: { ...prefs, makes: next } });
    setTicked(toolsFor(next, mine));
  };
  const toggleMake = (m: Make) => {
    setUnsure(false);
    setMakes(makes.includes(m) ? makes.filter((x) => x !== m) : MAKES.filter((x) => x === m || makes.includes(x)));
  };
  // "Not sure yet" is exclusive: on = every tool on and no answer ticked; picking an answer turns it off again
  const notSure = unsure ?? (makes.length === 0 && tools.length > 0 && tools.length === mine.length);
  const pickNotSure = () => {
    setMakes([]);
    setUnsure(!notSure);
    if (!notSure) setTicked([...mine]);
  };
  const more = moreNeeds(tools, view.have);
  const assistantOn = view.have.includes("ai");

  return (
    <>
      {savedNote}
      <Dialog open onOpenChange={(o) => !o && close()}>
        <DialogContent
          showCloseButton={false}
          // a press outside (the Mac window's title bar, the page behind) never closes setup
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className={cn(
            // as tall as the screen allows (680px at most): the header and footer stay put and only the body scrolls,
            // so a small window shows a usable step rather than a thin strip
            "flex h-[min(680px,calc(100dvh-2rem))] w-[min(820px,calc(100vw-3rem))] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl shadow-black/40 sm:max-w-none",
            "max-sm:h-dvh max-sm:w-screen max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]",
          )}
        >
          <header className="shrink-0 px-6 pt-5 sm:px-8">
            <div className="flex items-center gap-3">
              {/* the welcome has no bar; the bar shows the three stages on the steps that belong to one. A stage passed on this path is ticked */}
              {stage >= 0 && (
                <ol className="flex flex-1 items-center gap-2" aria-label={`Stage ${stage + 1} of ${STAGES.length}`}>
                  {STAGES.map((s, i) => {
                    const passed = i < stage && order.includes(s);
                    return (
                    <li key={s} className="flex min-w-0 flex-1 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => to(s)}
                        disabled={i >= stage}
                        aria-current={i === stage ? "step" : undefined}
                        className={cn("flex min-w-0 items-center gap-2 text-sm enabled:cursor-pointer enabled:hover:text-foreground", i > stage ? "text-muted-foreground" : "text-foreground")}
                      >
                        <span
                          className={cn(
                            "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums transition-colors",
                            passed ? "border-[var(--tint)] bg-[var(--tint)] text-white" : i === stage ? "border-[var(--tint)] text-[var(--tint-text)]" : "border-border text-muted-foreground",
                          )}
                        >
                          {passed ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
                        </span>
                        <span className="truncate">{STAGE_NAME[s]}</span>
                      </button>
                      {i < STAGES.length - 1 && <span className="h-px flex-1 bg-border" />}
                    </li>
                    );
                  })}
                </ol>
              )}
              {stage < 0 && <span className="flex-1" />}
              <button
                type="button"
                onClick={close}
                aria-label="Not now"
                title="Not now"
                className="-mr-2 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            {step === "how" && <p className="mt-5 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--tint-text)]">Welcome to Creator Toolset</p>}
            <DialogTitle className={cn("text-2xl font-semibold tracking-tight", step === "how" ? "mt-1.5" : "mt-5")}>{STEP[step].title}</DialogTitle>
            <DialogDescription className="mt-1.5 text-sm">{STEP[step].hint}</DialogDescription>
          </header>

          <div key={step} className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-5 sm:px-8 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2 motion-safe:duration-200">
            {step === "how" && <HowPicker value={prefs.talk} onChange={(t) => void setTalk(t)} />}

            {step === "make" && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-1.5 min-[720px]:grid-cols-3" role="group" aria-label="What will you make?">
                  {MAKES.map((m) => (
                    <Choice key={m} dense multi on={!notSure && makes.includes(m)} onClick={() => toggleMake(m)} icon={MAKE_ICONS[m]} name={MAKE_NAMES[m]} />
                  ))}
                  <Choice dense multi on={notSure} onClick={pickNotSure} icon={Sparkles} name="Not sure yet, show me everything" />
                </div>
                <details className="group rounded-xl border border-border/60 bg-card/40">
                  <summary className="cursor-pointer list-none px-4 py-3 text-sm text-muted-foreground hover:text-foreground">Your tools: {tools.length} on</summary>
                  <div className="px-4 pb-4">
                    <ToolsPicker tools={mine} value={tools} onChange={setTicked} />
                  </div>
                </details>
              </div>
            )}

            {step === "project" && (
              <ProjectForm
                key={projects[0]?.id ?? "new"}
                variant="setup"
                formId={PROJECT_FORM}
                busy={false}
                initial={projects[0]}
                onReady={setNamed}
                onSave={(f) => (projects.length ? patchProject(projects[0]!.id, f) : createProject(f)).then(() => void next())}
              />
            )}

            {step === "connect" && <ConnectStep picked={pickedIds} onPick={pick} />}

            {step === "agents" && <AgentsStep picked={pickedIds} />}

            {step === "folders" && <FoldersStep onNext={() => to(after)} actions={footerSlot} />}

            {step === "done" && (
              <div className="space-y-4">
                {prefs.talk !== "chat" && (
                  <p className="px-1 text-sm text-muted-foreground">
                    {assistantOn
                      ? "Your assistant is ready to help. It says hello in the corner."
                      : "Your assistant needs your AI connected first. You can do that any time in Settings → Your AI."}
                  </p>
                )}
                {more.length > 0 && (
                  <details className="group rounded-xl border border-border/60 bg-card/40 px-4">
                    <summary className="cursor-pointer list-none py-3 text-sm text-muted-foreground hover:text-foreground">More you can connect ({more.length})</summary>
                    <ul className="divide-y divide-border pb-1">
                      {more.map((n) => (
                        <MoreRow key={n.anyOf[0]} need={n} />
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>

          <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8">
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={close}>
              Not now
            </Button>
            <div className="flex items-center gap-2">
              {before && (
                <Button variant="ghost" onClick={() => to(before)}>
                  Back
                </Button>
              )}
              {/* the folders step puts its own buttons here (Do not add folders, Add N folders) */}
              {step === "folders" && <div ref={setFooterSlot} className="flex items-center gap-2" />}
              {step !== "folders" &&
                (last ? (
                  <Button onClick={() => void finish()} className="min-w-28 bg-[var(--tint)] text-white hover:bg-[var(--tint)] hover:brightness-110">
                    Open Review
                  </Button>
                ) : (
                  <>
                    {newProject && (
                      <Button variant="ghost" className="text-muted-foreground" onClick={() => void next()}>
                        Skip
                      </Button>
                    )}
                    <Button
                      // the project step submits its form (its own checks, then the save, then on)
                      {...(step === "project" ? { type: "submit" as const, form: PROJECT_FORM, disabled: !named } : { onClick: () => void next() })}
                      className="min-w-28 bg-[var(--tint)] text-white hover:bg-[var(--tint)] hover:brightness-110"
                    >
                      {step === "project" && !projects.length ? "Create project" : "Continue"}
                    </Button>
                  </>
                ))}
            </div>
          </footer>
        </DialogContent>
      </Dialog>
    </>
  );
}
