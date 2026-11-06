import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Check } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { ConnectorsSection } from "@/components/settings/ConnectorsSection";
import { ProjectForm } from "@/components/workshop/ProjectForm";
import { KnowledgePanel } from "@/components/workshop/KnowledgePanel";
import { canUse, isDemo, isGuest, useViewedMe } from "@/lib/auth";
import { createProject } from "@/lib/workshop";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";

const STEPS = [
  { id: "ai", title: "Your AI", hint: "Creator Toolset runs on your own AI subscriptions (Claude, ChatGPT/Codex, Grok…) through the Mac app: pick one per session, run several at once." },
  { id: "connectors", title: "Your accounts", hint: "Log in to Instagram & Facebook, YouTube and TikTok for your own numbers, and add your Apify key to read public profiles (X too). Your keys, your costs." },
  { id: "project", title: "Your first project", hint: "One project per brand: its Instagram, what's true about it, which knowledge it uses." },
  { id: "knowledge", title: "Your knowledge", hint: "Dump anything you write from: books, studies, old scripts, videos, references. Claude reads and files each one; you can check and change how." },
] as const;
type Step = (typeof STEPS)[number]["id"];

const seenKey = (u: string) => `ct-setup-done:${u}`;

/**
 * First-login setup. Each step is the
 * same screen as in Settings / the Workshop, so nothing here is a second copy; every step can be skipped and the
 * whole thing reopened with ?setup=ai (Settings → General). Shows itself on the first login of a Workshop user with no project.
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

  const step: Step | null = asked && STEPS.some((s) => s.id === asked) ? asked : auto ? "ai" : null;
  if (!real || !step) return null;
  const at = STEPS.findIndex((s) => s.id === step);
  const go = (next: Step | null) => {
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
    <Dialog open onOpenChange={(o) => !o && go(null)}>
      <DialogContent className="flex h-[min(860px,calc(100dvh-2rem))] w-[min(980px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <div className="border-b border-border px-6 pb-4 pt-5">
          <DialogTitle>Set up Creator Toolset</DialogTitle>
          <DialogDescription className="mt-1">{STEPS[at]!.hint}</DialogDescription>
          <ol className="mt-3 flex flex-wrap gap-1.5 text-xs">
            {STEPS.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => go(s.id)}
                  className={cn("flex items-center gap-1 rounded-full border px-2.5 py-1", s.id === step ? "border-violet-500 bg-violet-500/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
                >
                  {i < at ? <Check className="h-3 w-3" /> : <span>{i + 1}</span>} {s.title}
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {step === "ai" && <ProvidersSection />}
          {step === "connectors" && <ConnectorsSection back="/?setup=connectors" compact />}
          {step === "project" &&
            (projects.length ? (
              <p className="text-sm text-muted-foreground">
                You have {projects.length === 1 ? `a project: ${projects[0]!.name}` : `${projects.length} projects`}. Add more from the Workshop's project switcher.
              </p>
            ) : (
              <ProjectForm busy={false} onSave={(f) => createProject(f).then(() => go("knowledge"))} onCancel={() => go("knowledge")} />
            ))}
          {step === "knowledge" && <KnowledgePanel />}
        </div>
        <div className="flex items-center justify-between border-t border-border px-6 py-3">
          <Button variant="ghost" size="sm" onClick={() => go(null)}>
            Finish later
          </Button>
          <div className="flex gap-2">
            {at > 0 && (
              <Button variant="outline" size="sm" onClick={() => go(STEPS[at - 1]!.id)}>
                Back
              </Button>
            )}
            {nextStep ? (
              <Button size="sm" onClick={() => go(nextStep)}>
                {step === "project" && !projects.length ? "Skip" : "Next"}
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
