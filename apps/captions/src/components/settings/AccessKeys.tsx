import { useEffect, useState } from "react";
import { Check, Copy, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, EmptyRow, ErrorRow, FormDialog, ListRow, LoadingRow, RowMenu, Section, saveFailed } from "./ui";
import { fmtAgo, msg } from "./helpers";

/** An access key as the server lists it (api/auth.ts GET /api-key): per level, null when there is none. */
type KeyInfo = { at?: number; last4?: string; usedAt?: number } | null;
type Keys = { review: KeyInfo; full: KeyInfo };
type Level = "review" | "full";

/** One key per level: a new key of a level turns the old one off (api/users.ts newApiKey). */
const LEVELS: Record<Level, { name: string; what: string }> = {
  review: {
    name: "Review only",
    what: "Reads your Review videos and comments, resolves a comment once it made the change, uploads a cut.",
  },
  full: {
    name: "Full access",
    what: "Does what you can do on the site: Workshop projects, sessions, pieces, chat and Review. Never Admin, AI settings, paired Macs or your sign-in.",
  },
};

async function json<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as T;
}

/**
 * Settings → Headless access, "Access keys": keys that let your own AI or a script act as you here. On a solo install the
 * account is the local one (api/auth.ts keyAccount), so it works without sign-in too. Making one opens a dialog that
 * shows the key once.
 */
export function AccessKeysSection() {
  const [keys, setKeys] = useState<Keys | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () =>
    fetch("/api/auth/api-key")
      .then((r) => json<Keys>(r))
      .then((k) => (setKeys(k), setError(null)))
      .catch((e) => setError(msg(e)));
  useEffect(() => {
    void load();
  }, []);

  const turnOff = (level: Level) =>
    fetch(`/api/auth/api-key?level=${level}`, { method: "DELETE" })
      .then((r) => json<Keys>(r))
      .then(setKeys)
      .catch((e) => (saveFailed(msg(e)), void load()));

  const live = keys ? (["review", "full"] as const).filter((l) => keys[l]) : [];

  return (
    <Section
      id="access-keys"
      title="Access keys"
      action={
        <Button size="xs" variant="ghost" onClick={() => setCreating(true)}>
          <Plus className="size-3" /> New key
        </Button>
      }
    >
      <Card>
        {!keys ? (
          error ? <ErrorRow title="Couldn't load your access keys" detail={error} retry={() => void load()} /> : <LoadingRow />
        ) : live.length === 0 ? (
          <EmptyRow title="No access keys yet" description="An access key lets your own AI or a script work here as you. It is shown once." />
        ) : (
          live.map((level) => {
            const k = keys[level];
            const made = k?.at ? new Date(k.at).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : null;
            const used = k?.usedAt ? `last used ${fmtAgo(k.usedAt)}` : "not used yet";
            return (
              <ListRow
                key={level}
                title={LEVELS[level].name}
                subtitle={[made && `Made ${made}`, used].filter(Boolean).join(" · ")}
                actions={
                  <RowMenu
                    label={`${LEVELS[level].name} key actions`}
                    items={[
                      {
                        label: "Turn off",
                        destructive: true,
                        confirm: { title: `Turn off the ${LEVELS[level].name} key?`, body: "Whatever uses it stops working. You can make a new one.", ok: "Turn off" },
                        onSelect: () => turnOff(level),
                      },
                    ]}
                  />
                }
              />
            );
          })
        )}
      </Card>
      <NewKeyDialog
        open={creating}
        onOpenChange={setCreating}
        onMade={() => void load()}
      />
    </Section>
  );
}

/** Makes a key of the chosen level and shows it once, with a copy button. Closing forgets it. */
function NewKeyDialog({ open, onOpenChange, onMade }: { open: boolean; onOpenChange: (o: boolean) => void; onMade: () => void }) {
  const [level, setLevel] = useState<Level>("review");
  const [made, setMade] = useState<{ level: Level; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setMade(null);
    setError(null);
    setLevel("review");
    setCopied(false);
  };

  const submit = async () => {
    if (made) {
      onOpenChange(false);
      reset();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/api-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ level }) });
      const j = (await r.json().catch(() => null)) as { key?: string; error?: string } | null;
      if (!r.ok || !j?.key) throw new Error(j?.error || "Couldn't make a key. Try again.");
      setMade({ level, value: j.key });
      onMade();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="New access key"
      submitLabel={made ? "Done" : "Create key"}
      onSubmit={submit}
      busy={busy}
      error={error}
      cancelLabel={made ? "Close" : "Cancel"}
    >
      {made ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{LEVELS[made.level].name} key. Shown once: copy it now.</p>
          <div className="flex gap-2">
            <input
              readOnly
              aria-label="New access key"
              value={made.value}
              onFocus={(e) => e.currentTarget.select()}
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 font-mono text-xs"
            />
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="Copy the key"
              onClick={() =>
                void navigator.clipboard.writeText(made.value).then(
                  () => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  },
                  () => saveFailed("Couldn't copy it. Select the key and copy it."),
                )
              }
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Add it in your AI app's connector settings (MCP), or send it as <code>Authorization: Bearer</code> with the key.
          </p>
        </div>
      ) : (
        <fieldset className="grid gap-2">
          <legend className="sr-only">Access</legend>
          {(["review", "full"] as const).map((l) => (
            <label key={l} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 p-3 has-[:checked]:border-foreground/40">
              <input type="radio" name="access-level" value={l} checked={level === l} onChange={() => setLevel(l)} className="mt-1" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{LEVELS[l].name}</span>
                <span className="block text-xs text-muted-foreground">{LEVELS[l].what}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">A new key turns off the old key of its kind.</p>
        </fieldset>
      )}
    </FormDialog>
  );
}
