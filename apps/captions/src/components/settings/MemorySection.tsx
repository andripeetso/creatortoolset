import { useEffect, useRef, useState } from "react";
import type { MemoryFact } from "@contracts/memory";
import { MEMORY_RULE_MAX } from "@contracts/memory";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCachedLoad } from "@/lib/local-cache";
import { Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, RowMenu, Section, WorkspacePick, WorkspaceTag, inWorkspace, moveItems, useSettingsWorkspace } from "./ui";

/** This window's own change reads the list again too. */
const OWN_TOO = { own: true };

/** One call to the rules' routes (api/memory.ts). `workspace`: the one the call works in, when it is not the window's. */
async function call<T>(path = "", method = "GET", body?: unknown, workspace?: string | null): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) };
  const r = await fetch(`/api/memory${path}`, inWorkspace(workspace, init)).catch(() => null);
  if (!r) throw new Error("Could not reach the server");
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `Failed (${r.status})`);
  return data;
}

/**
 * Settings → Memory: the rules the assistant keeps from one chat to the next (api/memory.ts): the rule it wrote, what
 * the person said under it, and the row's menu: Edit, Rewrite (the AI writes it again, shown in Edit before it is
 * saved), Move to another workspace or to every workspace, Delete. The workspace selector starts on All workspaces
 * (every rule, each with its workspace); one picked shows its own rules and the ones for every workspace.
 */
export function MemorySection() {
  const w = useSettingsWorkspace("list");
  const url = w.all ? "/api/memory?all=1" : "/api/memory";
  const kept = useCachedLoad<{ facts: MemoryFact[] }>(url, () => call<{ facts: MemoryFact[] }>(w.all ? "?all=1" : "", "GET", undefined, w.id), { ...OWN_TOO, workspace: w.cacheKey });
  const [editing, setEditing] = useState<{ fact: MemoryFact; rewrite: boolean } | null>(null);
  const facts = kept.data?.facts;
  const refresh = kept.refresh;
  return (
    <Section id="memory-rules" title="Rules">
      <WorkspacePick mode="list" />
      <Card>
        {!facts ? (
          kept.error ? (
            <ErrorRow title="Could not load rules" detail={kept.error} retry={() => void refresh().catch(() => {})} />
          ) : (
            <LoadingRow />
          )
        ) : (
          <>
            {!facts.length && <EmptyRow title="No rules" />}
            {facts.map((f) => (
              <ListRow
                key={f.id}
                // a rule is one sentence: it wraps rather than being cut
                title={<span className="whitespace-normal font-normal [overflow-wrap:anywhere]">{f.text}</span>}
                subtitle={f.said && <span title={f.said}>You said “{f.said}”</span>}
                status={w.all ? <WorkspaceTag id={f.project?.id} /> : undefined}
                actions={
                  <RowMenu
                    label="Rule actions"
                    items={[
                      { label: "Edit", onSelect: () => setEditing({ fact: f, rewrite: false }) },
                      { label: "Rewrite", onSelect: () => setEditing({ fact: f, rewrite: true }) },
                      ...moveItems(w.workspaces, f.project?.id, (to) => call(`/${f.id}/workspace`, "PUT", { workspace: to }).then(refresh)),
                      { label: "Delete", destructive: true, confirm: { title: "Delete this rule?" }, onSelect: () => call(`/${f.id}`, "DELETE").then(refresh) },
                    ]}
                  />
                }
              />
            ))}
          </>
        )}
      </Card>
      {editing && <EditRule key={editing.fact.id} fact={editing.fact} rewriteFirst={editing.rewrite} onClose={() => setEditing(null)} onSaved={() => void refresh().catch(() => {})} />}
    </Section>
  );
}

/** Edit one rule. Rewrite asks the AI for a new wording and puts it in the box; nothing is saved until Save. */
function EditRule({ fact, rewriteFirst, onClose, onSaved }: { fact: MemoryFact; rewriteFirst: boolean; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(fact.text);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rewrite = async () => {
    setError(null);
    setWriting(true);
    try {
      setText((await call<{ text: string }>(`/${fact.id}/rewrite`, "POST")).text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rewrite the rule");
    } finally {
      setWriting(false);
    }
  };
  // Rewrite from the menu: start at once, in the dialog that shows the result (once, also under StrictMode)
  const started = useRef(false);
  useEffect(() => {
    if (!rewriteFirst || started.current) return;
    started.current = true;
    void rewrite();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on open only
  }, []);
  const save = async () => {
    if (text.trim() === fact.text) return onClose();
    setBusy(true);
    setError(null);
    try {
      await call(`/${fact.id}`, "PATCH", { text });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      setBusy(false);
    }
  };
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit rule"
      description={fact.said ? `You said “${fact.said}”` : undefined}
      submitLabel="Save"
      onSubmit={save}
      busy={busy}
      submitDisabled={writing}
      error={error}
    >
      <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={MEMORY_RULE_MAX} rows={3} required disabled={writing} aria-label="Rule" />
      <Button type="button" size="sm" variant="outline" onClick={() => void rewrite()} disabled={writing || busy}>
        {writing ? "Rewriting…" : "Rewrite"}
      </Button>
    </FormDialog>
  );
}
