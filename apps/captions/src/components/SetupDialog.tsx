import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Check } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { ConnectorsSection } from "@/components/settings/ConnectorsSection";
import { MyKeysSection } from "@/components/settings/MyKeysSection";
import { ProjectForm } from "@/components/workshop/ProjectForm";
import { canUse, isDemo, isGuest, useViewedMe } from "@/lib/auth";
import { createProject } from "@/lib/workshop";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";

const STEPS = [
  { id: "project", title: "Your first project", hint: "One project per brand: its name, your Instagram handle, and who you make it for (in Instructions). This step is the only one you need." },
  { id: "ai", title: "Your AI", hint: "The AI runs on your own account, never anyone else's. Pair your Mac to use the Claude Code or Codex you are signed in to, on your own subscription. Or add your own Anthropic API key: Anthropic bills you for what you use." },
  { id: "connectors", title: "Instagram", hint: "Log in with Meta, the official way: your own posts and their numbers, free. That is all the official login gives. To read other creators' posts too, add your own Apify key: Apify bills you for each read." },
  { id: "keys", title: "Other keys", hint: "Optional. Each key turns on one thing, and that provider bills you for it directly. Skip any you don't need: a tool that needs one says so." },
] as const;
const OTHER_KEYS = ["DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY", "NVIDIA_API_KEY", "PERPLEXITY_API_KEY", "TYPESAFE_API_KEY", "OPENAI_API_KEY"] as const;
type Step = (typeof STEPS)[number]["id"];

const seenKey = (u: string) => `ct-setup-done:${u}`;

/**
 * First-run setup. Each step is the same screen as in Settings / the Workshop, so nothing here is a second copy. The
 * first project is required (while a Workshop user has none the dialog can't be closed); every other step can be
 * skipped, and the whole thing reopened with ?setup=project (Settings → General). Opens by itself after "Create
 * account" (AuthGate) and on the first login of a Workshop user with no project. On a phone it is a full-screen sheet;
 * a step's link into Settings (Connect a Mac) comes back here when Settings closes (App.tsx keeps the page behind it).
 */
export function SetupDialog() {
  const me = useViewedMe();
  const { projects, loaded, load } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const asked = params.get("setup") as Step | null;
  const real = !!me && !isGuest(me) && !isDemo(me);
  // shown by itself only on a first login of someone who has the Workshop; anyone can open it from Settings
  const firstLogin = real && canUse(me, "workshop") && (me.logins ?? Infinity) <= 1;
  const [auto, setAuto] = useState(false);

  useEffect(() => {
    if (real && !loaded) void load();
  }, [real, loaded, load]);
  useEffect(() => {
    if (!firstLogin || !loaded || projects.length) return;
    try {
      if (!localStorage.getItem(seenKey(me!.username))) setAuto(true);
    } catch {
      /* private mode: no automatic setup */
    }
  }, [firstLogin, loaded, projects.length, me]);

  const asked_: Step | null = asked && STEPS.some((s) => s.id === asked) ? asked : auto ? "project" : null;
  // no project yet: that step first, and nothing else until it's made
  const required = loaded && canUse(me, "workshop") && !projects.length;
  const step: Step | null = asked_ && required ? "project" : asked_;
  if (!real || !step) return null;
  const at = STEPS.findIndex((s) => s.id === step);
  const go = (next: Step | null) => {
    if (required && next !== "project") return;
    if (next) return setParams((p) => (p.set("setup", next), p), { replace: true });
    try {
      localStorage.setItem(seenKey(me.username), "1");
    } catch {
      /* fine */
    }
    setAuto(false);
    setParams((p) => (p.delete("setup"), p), { replace: true });
  };
  const nextStep = STEPS[at + 1]?.id ?? null;

  return (
    <Dialog open onOpenChange={(o) => !o && !required && go(null)}>
      <DialogContent showCloseButton={!required} className="flex h-[min(860px,calc(100dvh-2rem))] w-[min(980px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none max-sm:h-dvh max-sm:w-screen max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]">
        <div className="border-b border-border px-4 pb-4 pt-5 sm:px-6">
          <DialogTitle>Set up Creator Toolset</DialogTitle>
          <DialogDescription className="mt-1">{STEPS[at]!.hint}</DialogDescription>
          <ol className="mt-3 flex flex-wrap gap-1.5 text-xs">
            {STEPS.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => go(s.id)}
                  disabled={required && s.id !== "project"}
                  className={cn("flex items-center gap-1 rounded-full border px-2.5 py-1 disabled:opacity-50", s.id === step ? "border-violet-500 bg-violet-500/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
                >
                  {i < at ? <Check className="h-3 w-3" /> : <span>{i + 1}</span>} {s.title}
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          {step === "project" &&
            (projects.length ? (
              <p className="text-sm text-muted-foreground">
                You have {projects.length === 1 ? `a project: ${projects[0]!.name}` : `${projects.length} projects`}. Add more from the Workshop's project switcher.
              </p>
            ) : (
              // createProject reloads the projects, so `required` is off before the next step
              <ProjectForm busy={false} onSave={(f) => createProject(f).then(() => setParams((p) => (p.set("setup", "ai"), p), { replace: true }))} />
            ))}
          {step === "ai" && (
            <>
              <ProvidersSection />
              <h3 className="mb-2 mt-6 text-sm font-medium">Or an API key of your own</h3>
              <MyKeysSection only={["ANTHROPIC_API_KEY"]} />
            </>
          )}
          {step === "connectors" && <ConnectorsSection back="/?setup=connectors" compact />}
          {step === "keys" && <MyKeysSection only={[...OTHER_KEYS]} />}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
          {required ? (
            <span className="text-xs text-muted-foreground">Create a project to go on</span>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => go(null)}>
              Finish later
            </Button>
          )}
          <div className="flex gap-2">
            {at > 0 && (
              <Button variant="outline" size="sm" onClick={() => go(STEPS[at - 1]!.id)}>
                Back
              </Button>
            )}
            {nextStep ? (
              <Button size="sm" onClick={() => go(nextStep)} disabled={required}>
                Next
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => {
                  go(null);
                  navigate("/workshop");
                }}
              >
                Open the Workshop
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
