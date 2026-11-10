import { useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormDialog, InUse, ListRow, RowMenu, SecretField, Status } from "./ui";
import type { SearchRowId } from "./search";
import { msg } from "./helpers";

export interface KeyRowProps {
  id: SearchRowId;
  name: string;
  /** One line: the tools that use this key. */
  subtitle: string;
  where?: string;
  /** The person's own key is saved. */
  set: boolean;
  last4?: string;
  /** Shown read-only (the server's own key: Admin → Server keys, the Apify key from the .env): masked, no menu. */
  readOnly?: boolean;
  readOnlyText?: string;
  /**
   * The server's key serves this person (an admin's key from the .env or Admin → Server keys). Shown masked with its
   * source; `…` → "Use a different key" saves the person's own, which then wins.
   */
  served?: { from: "env" | "settings"; last4: string };
  /** Saved, but not working: the words that say why (red). */
  broken?: string;
  /** The Remove confirm's sentence. */
  removeBody?: string;
  /** Saves a key, or removes it (null). A throw shows in the dialog's field. */
  save: (value: string | null) => Promise<unknown>;
}

const masked = (last4?: string) => <span className="font-mono text-xs text-muted-foreground">••••{last4 ?? ""}</span>;
/** A key that is there and not known to be broken: its last characters, then the kit's green state. A broken one has its red line instead. */
const inUse = (last4: string | undefined, broken?: string) => (
  <>
    {masked(last4)}
    {!broken && <InUse>Active</InUse>}
  </>
);

/**
 * One API key: the service, what uses it, the masked key with the green Active and a `…` menu when a key is there, and
 * [Add key] when it is not set. A key the server serves shows masked with its source as the status, so the row keeps the same height
 * when the person saves their own (the status line stays: "Your own key is used"). Saving opens a small dialog with one
 * field, a "Get a key" link and [Save key].
 */
export function KeyRow({ id, name, subtitle, where, set, last4, readOnly, readOnlyText = "Set in .env", served, broken, removeBody, save }: KeyRowProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const status: ReactNode = readOnly ? (
    <Status>{readOnlyText}</Status>
  ) : broken ? (
    <Status tone="broken">{broken}</Status>
  ) : served ? (
    <Status>{set ? "Your own key is used" : served.from === "env" ? "Set in the server's .env" : "Set in Admin → Server keys"}</Status>
  ) : undefined;

  const actions: ReactNode = readOnly ? (
    last4 ? inUse(last4, broken) : undefined
  ) : set ? (
    <>
      {inUse(last4, broken)}
      <RowMenu
        label={`${name} actions`}
        items={[
          { label: "Replace key", onSelect: () => setOpen(true) },
          {
            label: "Remove key",
            destructive: true,
            confirm: {
              title: `Remove the ${name} key?`,
              body: served ? "The server's key is used again." : (removeBody ?? "The tools that use it stop until you add it again."),
              ok: "Remove",
            },
            onSelect: async () => {
              await save(null);
            },
          },
        ]}
      />
    </>
  ) : served ? (
    <>
      {inUse(served.last4, broken)}
      <RowMenu label={`${name} actions`} items={[{ label: "Use a different key", onSelect: () => setOpen(true) }]} />
    </>
  ) : (
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
      Add key
    </Button>
  );

  const submit = async () => {
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      await save(v);
      setValue("");
      setOpen(false);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ListRow id={id} title={name} subtitle={subtitle} status={status} actions={actions} />
      <FormDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setValue("");
            setError(null);
          }
        }}
        title={set ? `Replace the ${name} key` : served ? `Use your own ${name} key` : `Add the ${name} key`}
        submitLabel="Save key"
        onSubmit={submit}
        busy={busy}
      >
        <SecretField
          label={`${name} key`}
          value={value}
          onChange={(v) => {
            setValue(v);
            setError(null);
          }}
          last4={set ? last4 : undefined}
          placeholder="Paste the key"
          error={error ?? undefined}
        />
        {where && (
          <a href={where} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline underline-offset-2">
            Get a key <ExternalLink className="size-3" />
          </a>
        )}
      </FormDialog>
    </>
  );
}
