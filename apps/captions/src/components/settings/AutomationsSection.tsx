import { useEffect, useState } from "react";
import { describeSchedule } from "@contracts/automations";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { deleteAutomation, listAutomations, runAutomationNow, updateAutomation, type AutomationView } from "@/lib/automations";
import { Card, Group, Loading, Notice } from "./ui";
import { fmtAgo, msg } from "./helpers";

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Settings → Automations: each scheduled prompt with its on/off switch, its next run, its last result, Run now and
 * delete. Made from the assistant or from your own AI over the MCP (the automations_* tools), so there is no form here.
 */
export function AutomationsSection() {
  const [items, setItems] = useState<AutomationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () =>
    listAutomations()
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e) => setError(msg(e)));

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 15_000);   // a run in progress finishes here without a reload
    return () => clearInterval(t);
  }, []);

  const act = (fn: () => Promise<unknown>) => fn().then(reload).catch((e) => setError(msg(e)));

  if (!items) return error ? <Notice tone="error">Could not load automations: {error}</Notice> : <Loading />;

  return (
    <Group
      title="Automations"
      hint="A prompt the assistant runs on your AI at a set time, with the same tools as the chat: its result shows here and in your inbox. Ask the assistant, or your own AI chat, to set one up."
    >
      {error && <Notice tone="error">{error}</Notice>}
      {items.length === 0 ? (
        <Notice>No automations yet. Try: “every Monday at 9, pull my new Instagram posts and draft three hooks in the Workshop.”</Notice>
      ) : (
        <Card>
          {items.map((a) => (
            <div key={a.id} className="space-y-2 px-3 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-foreground">
                    {a.name}
                    {a.running && <span className="ml-2 text-xs text-amber-400">running</span>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {describeSchedule(a.schedule, a.timezone)}
                    {a.enabled && a.nextRun ? ` · next ${when(a.nextRun)}` : a.enabled ? "" : " · off"}
                  </div>
                </div>
                <Switch checked={a.enabled} onCheckedChange={(on) => void act(() => updateAutomation(a.id, { enabled: on }))} aria-label={`Turn ${a.name} on or off`} />
                <Button variant="outline" size="sm" disabled={a.running} onClick={() => void act(() => runAutomationNow(a.id))}>
                  Run now
                </Button>
                <ConfirmButton
                  label="Delete"
                  confirmLabel="Click again to delete"
                  title="Delete this automation for good"
                  onConfirm={() => act(() => deleteAutomation(a.id))}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-red-500/50 hover:text-red-600 dark:hover:text-red-300"
                  armedClassName="border-red-500/60 text-red-600 dark:text-red-300"
                />
              </div>
              <div className="text-xs text-muted-foreground">
                {a.lastResult ? (
                  <>
                    <span className={a.lastResult.status === "done" ? "text-emerald-400" : a.lastResult.status === "error" ? "text-red-400" : "text-amber-400"}>
                      {a.lastResult.status}
                    </span>
                    {` · ${fmtAgo(a.lastResult.at)}: ${a.lastResult.text.slice(0, 280)}`}
                  </>
                ) : (
                  "Not run yet"
                )}
              </div>
            </div>
          ))}
        </Card>
      )}
    </Group>
  );
}
