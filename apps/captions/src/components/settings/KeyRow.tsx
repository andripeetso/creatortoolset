import { useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormDialog, ListRow, RowMenu, SecretField, Status } from "./ui";
import type { SearchRowId } from "./search";
import { msg } from "./helpers";

export interface KeyRowProps {
  id: SearchRowId;
  name: string;
  /** One line: the tools that use this key. */
  subtitle: string;
  where?: string;
  /** A key is saved (here, or in the server's .env). */
  set: boolean;
  last4?: string;
  /** Set in the server's .env or by the server: shown read-only, nothing to change here. */
  readOnly?: boolean;
  readOnlyText?: string;
  /** Saved, but not working: the words that say why (red). */
  broken?: string;
  /** The Remove confirm's sentence. */
  removeBody?: string;
  /** Saves a key, or removes it (null). A throw shows in the dialog's field. */
  save: (value: string | null) => Promise<unknown>;
}

/**
 * One API key: the service, what uses it, the masked key with `…` (Replace, Remove after a confirm) when set, and
 * [Add key] when not. Saving opens a small dialog with one field, a "Get a key" link and [Save key].
 */
export function KeyRow({ id, name, subtitle, where, set, last4, readOnly, readOnlyText = "Set in .env", broken, removeBody, save }: KeyRowProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const status: ReactNode = readOnly ? (
    <Status>{readOnlyText}</Status>
  ) : broken ? (
    <Status tone="broken">{broken}</Status>
  ) : undefined;

  const actions: ReactNode = readOnly ? undefined : set ? (
    <>
      <span className="font-mono text-xs text-muted-foreground">••••{last4 ?? ""}</span>
      <RowMenu
        label={`${name} actions`}
        items={[
          { label: "Replace key", onSelect: () => setOpen(true) },
          {
            label: "Remove key",
            destructive: true,
            confirm: { title: `Remove the ${name} key?`, body: removeBody ?? "The tools that use it stop until you add it again.", ok: "Remove" },
            onSelect: async () => {
              await save(null);
            },
          },
        ]}
      />
    </>
  ) : (
    <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
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
        title={set ? `Replace the ${name} key` : `Add the ${name} key`}
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
