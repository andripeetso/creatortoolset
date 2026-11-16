import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCachedLoad } from "@/lib/local-cache";
import type { AiKeyInfo } from "./OwnAiSection";
import { Card, ErrorRow, ListRow, LoadingRow, RowMenu, Section, SettingsDialog, saveFailed } from "./ui";
import { CopyBox } from "./copy-box";
import { fmtAgo, msg } from "./helpers";

/** An access key as the server lists it (api/auth.ts GET /api-key): per level, null when there is none. */
type KeyInfo = { at?: number; last4?: string; usedAt?: number } | null;
type Keys = { review: KeyInfo; full: KeyInfo; ai?: AiKeyInfo[] };
type Level = "review" | "full";
const LEVEL_IDS = ["review", "full"] as const;

/** One key per level: a new key of a level replaces the old one (api/users.ts newApiKey). `what`: what the key reaches. */
const LEVELS: Record<Level, { name: string; what: string }> = {
  review: { name: "Review only", what: "Review videos and comments, and uploading a cut." },
  full: { name: "Full access", what: "Workspaces, projects, pieces, chat and Review." },
};

async function json<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as { error?: string } | null;
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as T;
}

/**
 * This account's keys as the server lists them (dates and the last 4 characters, never a key): the saved copy at once,
 * read again when an AI app uses its key for the first time (the server tells "setup" then). A new key's own text is
 * only ever in the dialog that made it.
 */
export const useAccessKeys = () =>
  useCachedLoad<Keys>("/api/auth/api-key", () => fetch("/api/auth/api-key").then((r) => json<Keys>(r)), { topic: "setup" });

/**
 * Settings → Headless access, "Access keys": the keys an AI app or a script uses this account with. On a solo install
 * the account is the local one (api/auth.ts keyAccount), so it works without sign-in too. Each level is a row with its
 * own action: Create key while it has none, then Change (a new key in its place) and Delete in its menu. A new key is
 * shown once, in a dialog.
 */
export function AccessKeysSection() {
  const { data: keys, error, refresh, set: setKeys } = useAccessKeys();
  const [busy, setBusy] = useState<Level | null>(null);
  const [made, setMade] = useState<{ level: Level; value: string } | null>(null);

  const load = () => refresh().catch(() => {});

  const create = async (level: Level) => {
    setBusy(level);
    try {
      const { key } = await fetch("/api/auth/api-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ level }) }).then((r) => json<{ key?: string }>(r));
      if (!key) throw new Error("Could not create the key. Try again.");
      setMade({ level, value: key });
    } catch (e) {
      saveFailed(msg(e));
    } finally {
      setBusy(null);
      void load();
    }
  };
  const remove = (level: Level) =>
    fetch(`/api/auth/api-key?level=${level}`, { method: "DELETE" })
      .then((r) => json<Keys>(r))
      .then(setKeys)
      .catch((e) => (saveFailed(msg(e)), void load()));

  return (
    <Section id="access-keys" title="Access keys">
      <Card>
        {!keys ? (
          error ? <ErrorRow title="Could not load access keys" detail={error} retry={() => void load()} /> : <LoadingRow />
        ) : (
          LEVEL_IDS.map((level) => {
            const k = keys[level];
            const { name, what } = LEVELS[level];
            const created = k?.at ? `Created ${new Date(k.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : null;
            return (
              <ListRow
                key={level}
                title={name}
                subtitle={what}
                status={k ? [created, k.usedAt ? `last used ${fmtAgo(k.usedAt)}` : "not used"].filter(Boolean).join(" · ") : undefined}
                actions={
                  k ? (
                    <RowMenu
                      label={`${name} key actions`}
                      items={[
                        { label: "Change", confirm: { title: `Change the ${name} key?`, body: "The current key stops working.", ok: "Change" }, onSelect: () => create(level) },
                        { label: "Delete", destructive: true, confirm: { title: `Delete the ${name} key?`, body: "Whatever uses it stops working.", ok: "Delete" }, onSelect: () => remove(level) },
                      ]}
                    />
                  ) : (
                    <Button size="sm" variant="outline" disabled={busy === level} onClick={() => void create(level)}>
                      {busy === level ? "Creating…" : "Create key"}
                    </Button>
                  )
                }
              />
            );
          })
        )}
      </Card>
      {made && (
        <SettingsDialog open onOpenChange={(o) => !o && setMade(null)}>
          <DialogContent className="sm:max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
            <DialogHeader>
              <DialogTitle>{LEVELS[made.level].name} key</DialogTitle>
              <DialogDescription>The key is shown once.</DialogDescription>
            </DialogHeader>
            <CopyBox text={made.value} />
            <p className="text-xs text-muted-foreground">
              Add it as a connector in the AI app, or send it from a script in the header <code>Authorization: Bearer KEY</code>.
            </p>
          </DialogContent>
        </SettingsDialog>
      )}
    </Section>
  );
}
