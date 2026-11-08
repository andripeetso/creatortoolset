import { useEffect, useState } from "react";
import type { WorkPrefs } from "@contracts/work-prefs";
import { Card, Footnote, Group, Row } from "./ui";
import { selectCls } from "./helpers";

const TALK_LABEL: Record<WorkPrefs["talk"], string> = { app: "In this app", chat: "In my own AI chat", both: "Both" };
const CHECK_LABEL: Record<WorkPrefs["check"], string> = { app: "In this app", editor: "In my own editor", both: "Both" };
const EDITOR_LABEL: Record<NonNullable<WorkPrefs["editor"]>, string> = {
  "resolve-studio": "DaVinci Resolve Studio",
  resolve: "DaVinci Resolve",
  premiere: "Premiere Pro",
  "final-cut": "Final Cut Pro",
  avid: "Avid Media Composer",
  other: "Other",
};

/** Settings → General: how you want to work (api/work-prefs.ts). The assistant and the MCP change the same record. */
export function WorkPrefsGroup() {
  const [prefs, setPrefs] = useState<WorkPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void fetch("/api/work-prefs").then(async (r) => r.ok && setPrefs((await r.json()) as WorkPrefs));
  }, []);
  if (!prefs) return null;

  const change = async (patch: Partial<WorkPrefs>) => {
    setError(null);
    const r = await fetch("/api/work-prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    const j = (await r.json().catch(() => ({}))) as WorkPrefs & { error?: string };
    if (r.ok) setPrefs(j);
    else setError(j.error ?? "Couldn't save");
  };

  return (
    <Group title="How you work" hint="Change it any time, or ask the assistant.">
      <Card>
        <Row label="Talk to the AI" hint="In this app, or in your own Claude Code or Codex through the app's connector.">
          <select value={prefs.talk} aria-label="Talk to the AI" onChange={(e) => void change({ talk: e.target.value as WorkPrefs["talk"] })} className={selectCls}>
            {Object.entries(TALK_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Row>
        <Row label="Check the work" hint="In Review and the edit page here, or in your own editor.">
          <select value={prefs.check} aria-label="Check the work" onChange={(e) => void change({ check: e.target.value as WorkPrefs["check"] })} className={selectCls}>
            {Object.entries(CHECK_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Row>
        {prefs.check !== "app" && (
          <Row label="Your editor">
            <select
              value={prefs.editor ?? ""}
              aria-label="Your editor"
              onChange={(e) => void change({ editor: (e.target.value || null) as WorkPrefs["editor"] })}
              className={selectCls}
            >
              <option value="">Pick one</option>
              {Object.entries(EDITOR_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Row>
        )}
      </Card>
      {error && <Footnote><span role="alert" className="text-destructive">{error}</span></Footnote>}
    </Group>
  );
}
